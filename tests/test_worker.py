"""The HTTP worker that runs jobs handed over by the serverless bot."""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import hashlib
import hmac as hmac_mod
import json
from typing import Any
from urllib.parse import parse_qsl

import aiohttp
import pytest
from aiohttp import web as aioweb
from aiohttp.test_utils import TestClient, TestServer

from app.cobalt import CobaltClient, Endpoint
from app.config import Settings
from app.context import Context
from app.worker import BadJob, PollRefused, Poller, StatusMessage, Worker, parse_job, sign_init_data

SECRET = "s" * 40
AUTH = {"Authorization": f"Bearer {SECRET}"}


def make_settings(**overrides: Any) -> Settings:
    base = dict(
        bot_token="1:t",
        cobalt_endpoints=(Endpoint("http://cobalt:9000"),),
        cobalt_api_key=None,
        required_channel=None,
        required_channel_url=None,
        max_download_mb=50,
        video_quality="1080",
        audio_format="mp3",
        audio_bitrate="128",
        youtube_video_codec="h264",
        youtube_better_audio=False,
        always_proxy=True,
        ytdlp_for_youtube=True,
        ytdlp_fallback_to_cobalt=False,
        ytdlp_cookies_file=None,
        telegram_api_url=None,
        telegram_api_local=True,
        telegram_timeout=900,
        max_concurrent_downloads=2,
        api_timeout=10,
        download_timeout=30,
        log_level="INFO",
        bot_mode="worker",
        worker_secret=SECRET,
    )
    base.update(overrides)
    return Settings(**base)


def job_payload(**overrides: Any) -> dict[str, Any]:
    payload = {
        "chat_id": 42,
        "message_id": 7,
        "user_id": 42,
        "url": "https://youtu.be/aqz-KE-bpKQ",
        "mode": "v",
        "quality": "720",
        "token": "abc_DEF-12",
    }
    payload.update(overrides)
    return payload


class FakeBot:
    def __init__(self) -> None:
        self.edits: list[dict[str, Any]] = []
        self.deleted: list[tuple[int, int]] = []

    async def edit_message_text(self, **kwargs: Any) -> None:
        self.edits.append(kwargs)

    async def delete_message(self, chat_id: int, message_id: int) -> None:
        self.deleted.append((chat_id, message_id))


class Recorder:
    """Stands in for run_job; `gate` lets a test hold a job in flight."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.gate = asyncio.Event()
        self.gate.set()

    async def __call__(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)
        await self.gate.wait()


@pytest.fixture
async def setup():
    settings = make_settings()
    ctx = Context(settings=settings, cobalt=CobaltClient(list(settings.cobalt_endpoints)))
    bot = FakeBot()
    recorder = Recorder()
    worker = Worker(bot, ctx, runner=recorder)  # type: ignore[arg-type]
    client = TestClient(TestServer(worker.app()))
    await client.start_server()
    try:
        yield client, worker, recorder, bot
    finally:
        recorder.gate.set()
        await client.close()


async def settle(worker: Worker) -> None:
    if worker.tasks:
        await asyncio.wait(list(worker.tasks), timeout=5)


# --------------------------------------------------------------------------- #
# payload validation
# --------------------------------------------------------------------------- #

def test_parse_job_accepts_a_valid_payload():
    job = parse_job(job_payload(prefs={"audio_format": "opus", "audio_bitrate": "320"}))
    assert job.chat_id == 42 and job.mode == "v" and job.quality == "720"
    settings = job.settings(make_settings())
    assert settings.audio_format == "opus"
    assert settings.audio_bitrate == "320"
    assert settings.video_quality == "1080"  # untouched


@pytest.mark.parametrize(
    "overrides",
    [
        {"url": "ftp://example.org/file"},
        {"url": ""},
        {"mode": "x"},
        {"quality": "9999"},
        {"chat_id": "42"},
        {"chat_id": True},
        {"token": "../../etc"},
        {"prefs": {"bot_token": "stolen"}},
        {"prefs": {"audio_format": "flac"}},
    ],
)
def test_parse_job_rejects_garbage(overrides):
    with pytest.raises(BadJob):
        parse_job(job_payload(**overrides))


def test_worker_mode_requires_a_secret():
    settings = make_settings(worker_secret=None)
    ctx = Context(settings=settings, cobalt=CobaltClient(list(settings.cobalt_endpoints)))
    with pytest.raises(RuntimeError):
        Worker(FakeBot(), ctx)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# http
# --------------------------------------------------------------------------- #

async def test_jobs_need_the_secret(setup):
    client, _, recorder, _ = setup
    for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": SECRET}):
        resp = await client.post("/worker/v1/jobs", json=job_payload(), headers=headers)
        assert resp.status == 401
    assert recorder.calls == []


async def test_health_hides_details_without_the_secret(setup):
    client, *_ = setup
    resp = await client.get("/worker/healthz")
    assert await resp.json() == {"ok": True}

    resp = await client.get("/worker/healthz", headers=AUTH)
    data = await resp.json()
    assert data["ok"] is True and "jobs" in data


async def test_accepted_job_runs_the_pipeline(setup):
    client, worker, recorder, _ = setup
    resp = await client.post(
        "/worker/v1/jobs", json=job_payload(prefs={"audio_format": "opus"}), headers=AUTH
    )
    assert resp.status == 202
    await settle(worker)

    [call] = recorder.calls
    assert call["chat_id"] == 42 and call["url"].startswith("https://youtu.be/")
    assert call["mode"] == "v" and call["quality"] == "720" and call["token"] == "abc_DEF-12"
    assert call["settings"].audio_format == "opus"
    status = call["status"]
    assert isinstance(status, StatusMessage) and status.message_id == 7


async def test_bad_payload_is_a_400(setup):
    client, *_ = setup
    resp = await client.post("/worker/v1/jobs", data=b"not json", headers=AUTH)
    assert resp.status == 400
    resp = await client.post("/worker/v1/jobs", json=job_payload(mode="x"), headers=AUTH)
    assert resp.status == 400


async def test_one_job_per_user(setup):
    client, worker, recorder, _ = setup
    recorder.gate.clear()

    first = await client.post("/worker/v1/jobs", json=job_payload(), headers=AUTH)
    assert first.status == 202
    second = await client.post("/worker/v1/jobs", json=job_payload(message_id=8), headers=AUTH)
    assert second.status == 409

    other = await client.post(
        "/worker/v1/jobs", json=job_payload(user_id=43, chat_id=43), headers=AUTH
    )
    assert other.status == 202

    recorder.gate.set()
    await settle(worker)
    again = await client.post("/worker/v1/jobs", json=job_payload(message_id=9), headers=AUTH)
    assert again.status == 202


async def test_queue_limit(setup):
    client, worker, recorder, _ = setup
    recorder.gate.clear()
    limit = worker.ctx.settings.worker_max_queue
    for user in range(limit):
        resp = await client.post(
            "/worker/v1/jobs", json=job_payload(user_id=1000 + user), headers=AUTH
        )
        assert resp.status == 202
    resp = await client.post("/worker/v1/jobs", json=job_payload(user_id=1), headers=AUTH)
    assert resp.status == 503


async def test_a_crashing_job_reports_and_frees_the_user(setup):
    client, worker, recorder, bot = setup

    async def boom(**kwargs: Any) -> None:
        raise RuntimeError("disk on fire")

    worker.runner = boom
    resp = await client.post("/worker/v1/jobs", json=job_payload(), headers=AUTH)
    assert resp.status == 202
    await settle(worker)

    assert any("disk on fire" in edit["text"] for edit in bot.edits)
    resp = await client.post("/worker/v1/jobs", json=job_payload(), headers=AUTH)
    assert resp.status == 202


async def test_status_message_edits_by_id():
    bot = FakeBot()
    status = StatusMessage(bot, chat_id=1, message_id=2)  # type: ignore[arg-type]
    await status.edit_text("hi")
    await status.delete()
    assert bot.edits == [{"text": "hi", "chat_id": 1, "message_id": 2, "reply_markup": None}]
    assert bot.deleted == [(1, 2)]


# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #

def test_worker_mode_config(monkeypatch):
    from app.config import load_settings

    monkeypatch.setenv("BOT_TOKEN", "1:t")
    monkeypatch.setenv("BOT_MODE", "worker")
    monkeypatch.delenv("TELEGRAM_API_URL", raising=False)
    monkeypatch.setenv("WORKER_SECRET", "short")
    with pytest.raises(RuntimeError, match="WORKER_SECRET"):
        load_settings()

    monkeypatch.setenv("WORKER_SECRET", SECRET)
    settings = load_settings()
    assert settings.is_worker and not settings.can_use_local_api

    monkeypatch.setenv("TELEGRAM_API_URL", "http://telegram-bot-api:8081")
    with pytest.raises(RuntimeError, match="TELEGRAM_API_URL"):
        load_settings()


def test_no_local_api_hint_in_worker_mode():
    from app.texts import too_large

    assert "локальный Bot API" not in too_large(120.0, 50, local_api_hint=False)


# --------------------------------------------------------------------------- #
# polling must not steal the bot from Telegram Serverless
# --------------------------------------------------------------------------- #

class WebhookBot:
    def __init__(self, url: str) -> None:
        self.url = url

    async def get_webhook_info(self):
        from types import SimpleNamespace

        return SimpleNamespace(url=self.url)


async def test_polling_refuses_to_delete_someone_elses_webhook(monkeypatch):
    from app.__main__ import StartupError, guard_webhook

    monkeypatch.delenv("TAKE_OVER_WEBHOOK", raising=False)
    await guard_webhook(WebhookBot(""))  # no webhook: fine
    with pytest.raises(StartupError, match="BOT_MODE=worker"):
        await guard_webhook(WebhookBot("https://app1.tgcloud.ai/hook"))

    monkeypatch.setenv("TAKE_OVER_WEBHOOK", "true")
    await guard_webhook(WebhookBot("https://app1.tgcloud.ai/hook"))


# --------------------------------------------------------------------------- #
# pull mode: the worker polls the bot on Telegram Serverless
# --------------------------------------------------------------------------- #

BOT_TOKEN = "123456:ABC-test-token"


def verify_init_data(init_data: str, bot_token: str) -> dict:
    """Telegram's own check, written out independently of the code under test."""
    fields = dict(parse_qsl(init_data, keep_blank_values=True))
    received = fields.pop("hash")
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac_mod.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac_mod.new(secret, check.encode(), hashlib.sha256).hexdigest()
    assert hmac_mod.compare_digest(received, expected), "bad signature"
    return fields


def test_signed_init_data_passes_telegrams_check():
    fields = verify_init_data(sign_init_data(BOT_TOKEN, 777, now=1_700_000_000), BOT_TOKEN)
    assert fields["auth_date"] == "1700000000"
    assert json.loads(fields["user"])["id"] == 777
    with pytest.raises(AssertionError):
        verify_init_data(sign_init_data(BOT_TOKEN, 777), "999:other-bot")


class FakeServerless:
    """The bot's workerPoll endpoint: checks the init data like the platform does."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.jobs: list[dict] = []
        self.reply: tuple[int, dict] | None = None

    async def handle(self, request: aioweb.Request) -> aioweb.Response:
        scheme, _, token = request.headers.get("Authorization", "").partition(" ")
        assert scheme == "TMA"
        try:
            verify_init_data(base64.b64decode(token).decode(), BOT_TOKEN)
        except AssertionError:
            return aioweb.json_response({"ok": False, "error_type": "UNAUTHORIZED", "description": "bad init data"}, status=401)
        body = await request.json()
        self.calls.append(body)
        if self.reply:
            return aioweb.json_response(self.reply[1], status=self.reply[0])
        if body["secret"] != SECRET:
            return aioweb.json_response(
                {"ok": False, "error_type": "ENDPOINT_ERROR", "description": "Wrong WORKER_SECRET", "parameters": {"code": "FORBIDDEN"}},
                status=400,
            )
        jobs, self.jobs = self.jobs[: body["max"]], self.jobs[body["max"]:]
        return aioweb.json_response({"ok": True, "result": {"jobs": jobs, "pollAfter": 0 if jobs else 3}})


@pytest.fixture
async def pull_setup():
    fake = FakeServerless()
    app = aioweb.Application()
    app.router.add_post("/api/workerPoll", fake.handle)
    server = TestServer(app)
    await server.start_server()

    settings = make_settings(bot_token=BOT_TOKEN, worker_pull_url=str(server.make_url("")).rstrip("/"))
    ctx = Context(settings=settings, cobalt=CobaltClient(list(settings.cobalt_endpoints)))
    recorder = Recorder()
    worker = Worker(FakeBot(), ctx, runner=recorder)  # type: ignore[arg-type]
    poller = Poller(worker, settings.worker_pull_url, bot_id=999)
    session = aiohttp.ClientSession()
    try:
        yield fake, poller, recorder, session
    finally:
        await session.close()
        await server.close()


async def test_poller_runs_queued_jobs_and_reports_them_done(pull_setup):
    fake, poller, recorder, session = pull_setup
    fake.jobs = [{"id": 11, "job": job_payload(message_id=70)}]

    assert await poller.poll_once(session) == 0
    await settle(poller.worker)
    [call] = recorder.calls
    assert call["status"].message_id == 70 and call["quality"] == "720"
    assert fake.calls[0]["info"]["version"] == "2.0.0"

    assert await poller.poll_once(session) == 3
    assert fake.calls[1]["done"] == [11]
    assert await poller.poll_once(session) == 3
    assert fake.calls[2]["done"] == [], "reported once"


async def test_poller_takes_no_more_than_it_has_room_for(pull_setup):
    fake, poller, recorder, session = pull_setup
    recorder.gate.clear()
    fake.jobs = [{"id": i, "job": job_payload(user_id=100 + i)} for i in range(30)]
    while fake.jobs and len(poller.worker.tasks) < poller.settings.worker_max_queue:
        await poller.poll_once(session)
    assert len(poller.worker.tasks) == poller.settings.worker_max_queue
    await poller.poll_once(session)
    assert fake.calls[-1]["max"] == 0


async def test_poller_explains_what_to_fix(pull_setup):
    fake, poller, recorder, session = pull_setup
    poller.settings = dataclasses.replace(poller.settings, worker_secret="x" * 40)
    with pytest.raises(PollRefused, match="WORKER_SECRET differs"):
        await poller.poll_once(session)

    poller.settings = dataclasses.replace(poller.settings, bot_token="999:other-bot", worker_secret=SECRET)
    with pytest.raises(PollRefused, match="BOT_TOKEN"):
        await poller.poll_once(session)

    poller.settings = dataclasses.replace(poller.settings, bot_token=BOT_TOKEN)
    fake.reply = (200, {"html": True})
    with pytest.raises(PollRefused, match="workerPoll failed"):
        await poller.poll_once(session)


async def test_finished_jobs_survive_a_failed_poll(pull_setup):
    fake, poller, recorder, session = pull_setup
    poller.finished = [5, 6]
    fake.reply = (500, {"ok": False, "error_type": "INTERNAL", "description": "Internal error"})
    with pytest.raises(PollRefused):
        await poller.poll_once(session)
    assert poller.finished == [5, 6]
    fake.reply = None
    await poller.poll_once(session)
    assert fake.calls[-1]["done"] == [5, 6]


def test_pull_url_must_be_https(monkeypatch):
    from app.config import load_settings

    monkeypatch.setenv("BOT_TOKEN", "1:t")
    monkeypatch.setenv("BOT_MODE", "worker")
    monkeypatch.setenv("WORKER_SECRET", SECRET)
    monkeypatch.delenv("TELEGRAM_API_URL", raising=False)
    monkeypatch.setenv("WORKER_SERVERLESS_URL", "http://app1.tgcloud.ai")
    with pytest.raises(RuntimeError, match="WORKER_SERVERLESS_URL"):
        load_settings()
    monkeypatch.setenv("WORKER_SERVERLESS_URL", "https://app1.tgcloud.ai/")
    assert load_settings().worker_pull_url == "https://app1.tgcloud.ai"
