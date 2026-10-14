"""The HTTP worker that runs jobs handed over by the serverless bot."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from aiohttp.test_utils import TestClient, TestServer

from app.cobalt import CobaltClient, Endpoint
from app.config import Settings
from app.context import Context
from app.worker import BadJob, StatusMessage, Worker, parse_job

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
