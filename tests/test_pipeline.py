"""Handler-level tests with stubbed Telegram objects."""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from aiohttp import web

from app.cobalt import CobaltClient, CobaltError, CobaltResult, Endpoint
from app.downloader import EmptyDownload
from app.config import Settings
from app.context import Context
from app import ytdlp
from app.handlers import extract_url, materialize, run_job, send_media
from app.keyboards import MODE_AUDIO, MODE_VIDEO


@dataclass
class FakeStatus:
    texts: list[str] = field(default_factory=list)
    deleted: bool = False

    async def edit_text(self, text: str, reply_markup: Any = None) -> None:
        self.texts.append(text)

    async def delete(self) -> None:
        self.deleted = True


@dataclass
class FakeBot:
    calls: list[tuple[str, dict]] = field(default_factory=list)

    async def send_chat_action(self, chat_id: int, action: str) -> None:
        self.calls.append(("chat_action", {"action": action}))

    def __getattr__(self, name: str):
        if not name.startswith("send_"):
            raise AttributeError(name)

        async def recorder(chat_id: int, file: Any = None, **kwargs: Any) -> None:
            self.calls.append((name, {"file": file, **kwargs}))

        return recorder


@pytest.fixture
async def files_server():
    async def one(request: web.Request) -> web.Response:
        return web.Response(body=b"v" * 512, headers={"Content-Type": "video/mp4"})

    async def empty(request: web.Request) -> web.Response:
        return web.Response(body=b"", headers={"Content-Type": "video/mp4"})

    app = web.Application()
    app.router.add_get("/clip.mp4", one)
    app.router.add_get("/track.m4a", one)
    app.router.add_get("/empty.mp4", empty)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}"
    finally:
        await runner.cleanup()


@pytest.fixture
async def ctx(files_server):
    settings = Settings(
        bot_token="1:t",
        cobalt_endpoints=(Endpoint(files_server),),
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
        ytdlp_for_youtube=False,
        ytdlp_fallback_to_cobalt=True,
        ytdlp_cookies_file=None,
        telegram_api_url=None,
        telegram_api_local=True,
        telegram_timeout=900,
        max_concurrent_downloads=2,
        api_timeout=10,
        download_timeout=30,
        log_level="INFO",
    )
    client = CobaltClient([files_server], api_timeout=10, download_timeout=30)
    await client.start()
    try:
        yield Context(settings=settings, cobalt=client)
    finally:
        await client.close()


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("https://youtu.be/dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ"),
        ("глянь это https://www.youtube.com/watch?v=abc пожалуйста", "https://www.youtube.com/watch?v=abc"),
        ("просто текст", None),
    ],
)
def test_extract_url(text, expected):
    class M:
        entities = None

    message = M()
    message.text = text
    assert extract_url(message) == expected


async def test_materialize_tunnel(ctx, files_server, tmp_path):
    status = FakeStatus()
    result = CobaltResult(status="tunnel", url=f"{files_server}/clip.mp4", filename="clip.mp4")
    path = await materialize(ctx, status, result, tmp_path, MODE_VIDEO)
    assert path is not None and path.name == "clip.mp4" and path.stat().st_size == 512


async def test_materialize_local_processing_single_track(ctx, files_server, tmp_path):
    status = FakeStatus()
    result = CobaltResult(
        status="local-processing",
        tunnels=[f"{files_server}/clip.mp4"],
        output_filename="clip.mp4",
    )
    path = await materialize(ctx, status, result, tmp_path, MODE_VIDEO)
    assert path is not None and path.exists()


async def test_materialize_without_url_reports_error(ctx, tmp_path):
    status = FakeStatus()
    result = CobaltResult(status="tunnel", url=None)
    assert await materialize(ctx, status, result, tmp_path, MODE_VIDEO) is None
    assert "ссылку" in status.texts[-1]


async def test_send_media_picks_video(ctx, tmp_path):
    bot = FakeBot()
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"data")
    await send_media(bot, ctx, 1, path, MODE_VIDEO, tmp_path)
    assert [name for name, _ in bot.calls if name.startswith("send_")] == ["send_video"]
    assert bot.calls[-1][1]["supports_streaming"] is True


async def test_audio_mode_forces_audio_even_for_mp4(ctx, tmp_path):
    bot = FakeBot()
    path = tmp_path / "song.mp4"
    path.write_bytes(b"data")
    await send_media(bot, ctx, 1, path, MODE_AUDIO, tmp_path)
    assert [name for name, _ in bot.calls if name.startswith("send_")] == ["send_audio"]


async def test_unknown_suffix_goes_as_document(ctx, tmp_path):
    bot = FakeBot()
    path = tmp_path / "thing.bin"
    path.write_bytes(b"data")
    await send_media(bot, ctx, 1, path, MODE_VIDEO, tmp_path)
    assert [name for name, _ in bot.calls if name.startswith("send_")] == ["send_document"]


async def test_materialize_propagates_empty_download(ctx, files_server, tmp_path):
    status = FakeStatus()
    result = CobaltResult(status="tunnel", url=f"{files_server}/empty.mp4", filename="clip.mp4")
    with pytest.raises(EmptyDownload):
        await materialize(ctx, status, result, tmp_path, MODE_VIDEO)


async def test_run_job_falls_back_to_local_processing(ctx, files_server, monkeypatch):
    """An empty server-side tunnel must trigger a second, local-processing pass."""
    answers = [
        CobaltResult(status="tunnel", url=f"{files_server}/empty.mp4", filename="clip.mp4"),
        CobaltResult(
            status="local-processing",
            tunnels=[f"{files_server}/clip.mp4"],
            output_filename="clip.mp4",
        ),
    ]
    asked: list[str] = []

    async def fake_process(url, **kwargs):
        asked.append(kwargs["local_processing"])
        return answers[len(asked) - 1]

    monkeypatch.setattr(ctx.cobalt, "process", fake_process)

    bot = FakeBot()
    status = FakeStatus()
    await run_job(
        bot=bot,
        ctx=ctx,
        chat_id=1,
        status=status,
        url="https://youtu.be/x",
        token="tok",
        mode=MODE_VIDEO,
        quality="1080",
    )

    assert asked == ["disabled", "preferred"]
    assert [name for name, _ in bot.calls if name.startswith("send_")] == ["send_video"]


async def test_run_job_reports_when_both_passes_are_empty(ctx, files_server, monkeypatch):
    """Two empty tunnels in a row is a failure, never a zero-byte upload."""

    async def fake_process(url, **kwargs):
        return CobaltResult(status="tunnel", url=f"{files_server}/empty.mp4", filename="clip.mp4")

    monkeypatch.setattr(ctx.cobalt, "process", fake_process)

    bot = FakeBot()
    status = FakeStatus()
    await run_job(
        bot=bot,
        ctx=ctx,
        chat_id=1,
        status=status,
        url="https://youtu.be/x",
        token="tok",
        mode=MODE_VIDEO,
        quality="1080",
    )

    assert not [name for name, _ in bot.calls if name.startswith("send_")]
    assert "пуст" in status.texts[-1].lower()


# --------------------------------------------------------------------------- #
# YouTube must go to yt-dlp, not to Cobalt
# --------------------------------------------------------------------------- #

def with_ytdlp(ctx, **overrides):
    ctx.settings = dataclasses.replace(ctx.settings, ytdlp_for_youtube=True, **overrides)
    return ctx


async def test_youtube_never_reaches_cobalt(ctx, tmp_path, monkeypatch):
    with_ytdlp(ctx)
    touched: list[str] = []

    async def fake_process(url, **kwargs):
        touched.append(url)
        raise AssertionError("Cobalt must not be asked about a YouTube link")

    async def fake_download(url, dest_dir, **kwargs):
        path = Path(dest_dir) / "clip.mp4"
        path.write_bytes(b"video")
        return ytdlp.YtDlpResult(path=path, title="clip", duration=5)

    monkeypatch.setattr(ctx.cobalt, "process", fake_process)
    monkeypatch.setattr(ytdlp, "download", fake_download)

    bot = FakeBot()
    await run_job(
        bot=bot, ctx=ctx, chat_id=1, status=FakeStatus(),
        url="https://youtu.be/dQw4w9WgXcQ", token="tok", mode=MODE_VIDEO, quality="1080",
    )

    assert touched == []
    assert [name for name, _ in bot.calls if name.startswith("send_")] == ["send_video"]


async def test_non_youtube_still_goes_to_cobalt(ctx, files_server, monkeypatch):
    with_ytdlp(ctx)
    asked: list[str] = []

    async def fake_process(url, **kwargs):
        asked.append(url)
        return CobaltResult(status="tunnel", url=f"{files_server}/clip.mp4", filename="clip.mp4")

    async def fake_download(url, dest_dir, **kwargs):
        raise AssertionError("yt-dlp must not touch a non-YouTube link")

    monkeypatch.setattr(ctx.cobalt, "process", fake_process)
    monkeypatch.setattr(ytdlp, "download", fake_download)

    bot = FakeBot()
    await run_job(
        bot=bot, ctx=ctx, chat_id=1, status=FakeStatus(),
        url="https://vimeo.com/12345", token="tok", mode=MODE_VIDEO, quality="1080",
    )

    assert asked == ["https://vimeo.com/12345"]
    assert [name for name, _ in bot.calls if name.startswith("send_")] == ["send_video"]


async def test_ytdlp_failure_is_shown_when_fallback_is_off(ctx, monkeypatch):
    with_ytdlp(ctx, ytdlp_fallback_to_cobalt=False)

    async def fake_download(url, dest_dir, **kwargs):
        raise ytdlp.YtDlpError("❌ Видео приватное.")

    async def fake_process(url, **kwargs):
        raise AssertionError("fallback is off, Cobalt must stay out of it")

    monkeypatch.setattr(ytdlp, "download", fake_download)
    monkeypatch.setattr(ctx.cobalt, "process", fake_process)

    status = FakeStatus()
    bot = FakeBot()
    await run_job(
        bot=bot, ctx=ctx, chat_id=1, status=status,
        url="https://youtu.be/x", token="tok", mode=MODE_VIDEO, quality="1080",
    )

    assert status.texts[-1] == "❌ Видео приватное."
    assert not [name for name, _ in bot.calls if name.startswith("send_")]


async def test_ytdlp_failure_falls_back_to_cobalt_when_enabled(ctx, files_server, monkeypatch):
    with_ytdlp(ctx, ytdlp_fallback_to_cobalt=True)

    async def fake_download(url, dest_dir, **kwargs):
        raise ytdlp.YtDlpError("❌ что-то пошло не так")

    async def fake_process(url, **kwargs):
        return CobaltResult(status="tunnel", url=f"{files_server}/clip.mp4", filename="clip.mp4")

    monkeypatch.setattr(ytdlp, "download", fake_download)
    monkeypatch.setattr(ctx.cobalt, "process", fake_process)

    bot = FakeBot()
    await run_job(
        bot=bot, ctx=ctx, chat_id=1, status=FakeStatus(),
        url="https://youtu.be/x", token="tok", mode=MODE_VIDEO, quality="1080",
    )

    assert [name for name, _ in bot.calls if name.startswith("send_")] == ["send_video"]
