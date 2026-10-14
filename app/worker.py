"""HTTP worker: runs the downloads the bot on Telegram Serverless hands over.

Telegram Serverless runs plain JavaScript in a V8 sandbox: no yt-dlp, no
ffmpeg, and at most 30 MB per outbound response. So the serverless bot keeps
the conversation (buttons, settings, the Mini App) and posts the heavy jobs
here: YouTube, files that do not fit its fetch cap, tracks that need muxing.

The worker runs the very same pipeline as the polling bot and talks to Telegram
directly with BOT_TOKEN: it edits the status message the serverless bot already
created and sends the file into the chat. It never calls getUpdates or
setWebhook — the webhook belongs to Serverless.

    POST /worker/v1/jobs     Authorization: Bearer <WORKER_SECRET>
    GET  /worker/healthz     the same header adds details
"""

from __future__ import annotations

import asyncio
import dataclasses
import hmac
import logging
import re
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

from aiogram import Bot
from aiogram.types import InlineKeyboardMarkup
from aiohttp import web

from . import texts, ytdlp
from .config import AUDIO_FORMATS, VIDEO_QUALITIES, YOUTUBE_CODECS, Settings
from .context import Context
from .handlers import edit, run_job
from .keyboards import MODE_AUDIO, MODE_VIDEO

log = logging.getLogger(__name__)

AUDIO_BITRATES = ("320", "256", "128", "96", "64", "8")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
MAX_URL_LENGTH = 2048

Runner = Callable[..., Awaitable[None]]


class BadJob(ValueError):
    """The payload does not describe a job; the message goes back to the caller."""


@dataclass(slots=True)
class StatusMessage:
    """The status message of a job, addressed by id.

    Quacks like the aiogram Message the pipeline edits in polling mode: the
    serverless bot created it, the worker only edits and deletes it.
    """

    bot: Bot
    chat_id: int
    message_id: int

    async def edit_text(self, text: str, reply_markup: InlineKeyboardMarkup | None = None) -> None:
        await self.bot.edit_message_text(
            text=text,
            chat_id=self.chat_id,
            message_id=self.message_id,
            reply_markup=reply_markup,
        )

    async def delete(self) -> None:
        await self.bot.delete_message(chat_id=self.chat_id, message_id=self.message_id)


@dataclass(frozen=True, slots=True)
class Job:
    chat_id: int
    message_id: int
    user_id: int
    url: str
    mode: str
    quality: str
    token: str
    prefs: dict[str, str]

    def settings(self, base: Settings) -> Settings:
        """The user's own defaults, as chosen in the bot or the Mini App."""
        return dataclasses.replace(base, **self.prefs) if self.prefs else base


def _int(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key)
    # bool is an int subclass; a chat id of True is a bug on the other side.
    if isinstance(value, bool) or not isinstance(value, int):
        raise BadJob(f"{key} must be an integer")
    return value


def parse_job(payload: Any) -> Job:
    if not isinstance(payload, dict):
        raise BadJob("payload must be a JSON object")

    url = payload.get("url")
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise BadJob("url must be a non-empty string")
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise BadJob("url must be an http(s) link")

    mode = payload.get("mode")
    if mode not in {MODE_VIDEO, MODE_AUDIO}:
        raise BadJob("mode must be 'v' or 'a'")

    quality = payload.get("quality", "-")
    if quality != "-" and quality not in VIDEO_QUALITIES:
        raise BadJob("unknown quality")

    token = payload.get("token", "")
    if not isinstance(token, str) or (token and not TOKEN_RE.match(token)):
        raise BadJob("token must be a short url-safe string")

    prefs: dict[str, str] = {}
    raw_prefs = payload.get("prefs") or {}
    if not isinstance(raw_prefs, dict):
        raise BadJob("prefs must be an object")
    allowed = {
        "video_quality": VIDEO_QUALITIES,
        "audio_format": AUDIO_FORMATS,
        "audio_bitrate": AUDIO_BITRATES,
        "youtube_video_codec": YOUTUBE_CODECS,
    }
    for key, value in raw_prefs.items():
        if key not in allowed:
            raise BadJob(f"unknown preference {key}")
        if value not in allowed[key]:
            raise BadJob(f"bad value for {key}")
        prefs[key] = value

    return Job(
        chat_id=_int(payload, "chat_id"),
        message_id=_int(payload, "message_id"),
        user_id=_int(payload, "user_id"),
        url=url,
        mode=mode,
        quality=quality,
        token=token,
        prefs=prefs,
    )


class Worker:
    def __init__(self, bot: Bot, ctx: Context, *, runner: Runner = run_job) -> None:
        if not ctx.settings.worker_secret:
            raise RuntimeError("WORKER_SECRET is required in worker mode")
        self.bot = bot
        self.ctx = ctx
        self.runner = runner
        self.tasks: set[asyncio.Task[None]] = set()
        self._secret = ctx.settings.worker_secret.encode()

    # ---------------------------------------------------------------- http

    def app(self) -> web.Application:
        app = web.Application(client_max_size=64 * 1024)
        app.router.add_post("/worker/v1/jobs", self.handle_job)
        app.router.add_get("/worker/healthz", self.handle_health)
        app.on_shutdown.append(self._on_shutdown)
        return app

    def authorized(self, request: web.Request) -> bool:
        header = request.headers.get("Authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token:
            return False
        return hmac.compare_digest(token.strip().encode(), self._secret)

    async def handle_health(self, request: web.Request) -> web.Response:
        if not self.authorized(request):
            return web.json_response({"ok": True})
        return web.json_response(
            {
                "ok": True,
                "ytdlp": ytdlp.version(),
                "jobs": len(self.tasks),
                "max_queue": self.ctx.settings.worker_max_queue,
                "max_download_mb": self.ctx.settings.max_download_mb,
                "ytdlp_for_youtube": self.ctx.settings.ytdlp_for_youtube,
            }
        )

    async def handle_job(self, request: web.Request) -> web.Response:
        if not self.authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        try:
            payload = await request.json()
        except ValueError:
            return web.json_response({"error": "body must be JSON"}, status=400)
        try:
            job = parse_job(payload)
        except BadJob as exc:
            return web.json_response({"error": str(exc)}, status=400)

        if len(self.tasks) >= self.ctx.settings.worker_max_queue:
            return web.json_response({"error": "overloaded"}, status=503)
        if not self.ctx.cooldown.acquire(job.user_id):
            return web.json_response({"error": "busy"}, status=409)

        task = asyncio.create_task(self.run(job))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        log.info("Accepted job for user %s: %s (%s)", job.user_id, job.url, job.mode)
        return web.json_response({"accepted": True, "queued": len(self.tasks)}, status=202)

    # ---------------------------------------------------------------- jobs

    async def run(self, job: Job) -> None:
        status = StatusMessage(self.bot, job.chat_id, job.message_id)
        try:
            async with self.ctx.slots:
                await self.runner(
                    bot=self.bot,
                    ctx=self.ctx,
                    chat_id=job.chat_id,
                    status=status,
                    url=job.url,
                    token=job.token,
                    mode=job.mode,
                    quality=job.quality,
                    settings=job.settings(self.ctx.settings),
                )
        except asyncio.CancelledError:
            with suppress(Exception):
                await edit(status, texts.WORKER_RESTARTED)
            raise
        except Exception as exc:  # noqa: BLE001 - one job must not take the worker down
            log.exception("Job for %s failed", job.url)
            with suppress(Exception):
                await edit(status, texts.UNKNOWN_ERROR.format(error=str(exc)[:300]))
        finally:
            self.ctx.cooldown.release(job.user_id)

    async def _on_shutdown(self, app: web.Application) -> None:
        for task in list(self.tasks):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)


async def serve(bot: Bot, ctx: Context, stop: asyncio.Event) -> None:
    """Serves jobs until `stop` is set."""
    settings = ctx.settings
    runner = web.AppRunner(Worker(bot, ctx).app(), access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, settings.worker_host, settings.worker_port)
    await site.start()
    log.info(
        "Worker listening on %s:%s — waiting for jobs from Telegram Serverless",
        settings.worker_host,
        settings.worker_port,
    )
    try:
        await stop.wait()
    finally:
        await runner.cleanup()
