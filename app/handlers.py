"""All bot handlers: subscription gate, link intake and the download pipeline."""

from __future__ import annotations

import asyncio
import logging
import re
import tempfile
from contextlib import suppress
from pathlib import Path

import aiohttp
from aiogram import Bot, F, Router
from aiogram.enums import ChatMemberStatus
from aiogram.exceptions import TelegramBadRequest, TelegramEntityTooLarge, TelegramRetryAfter
from aiogram.filters import Command, CommandStart
from aiogram.types import CallbackQuery, FSInputFile, InlineKeyboardMarkup, Message
from aiogram.utils.media_group import MediaGroupBuilder

from . import media, texts, ytdlp
from .cobalt import (
    STATUS_LOCAL_PROCESSING,
    STATUS_PICKER,
    CobaltError,
    CobaltResult,
    CobaltUnavailable,
)
from .context import Context
from .downloader import EmptyDownload, FileTooLarge, download_file, safe_filename
from .keyboards import (
    MODE_AUDIO,
    MODE_VIDEO,
    DownloadCallback,
    actions_kb,
    fallback_kb,
    quality_kb,
    subscribe_kb,
)

log = logging.getLogger(__name__)
router = Router(name="downloads")

URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
MAX_PICKER_ITEMS = 20
ALLOWED_MEMBER_STATUSES = {
    ChatMemberStatus.CREATOR,
    ChatMemberStatus.ADMINISTRATOR,
    ChatMemberStatus.MEMBER,
}


# --------------------------------------------------------------------------- #
# subscription gate
# --------------------------------------------------------------------------- #

async def is_subscribed(bot: Bot, ctx: Context, user_id: int) -> bool:
    channel = ctx.settings.required_channel
    if not channel:
        return True
    try:
        member = await bot.get_chat_member(channel, user_id)
    except TelegramBadRequest as exc:
        # Misconfiguration (bot is not an admin of the channel, wrong @username, …).
        # Failing open keeps the bot usable instead of locking every user out.
        log.error(
            "Cannot verify subscription for %s in %s: %s. Add the bot as an admin of the channel.",
            user_id,
            channel,
            exc.message,
        )
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("Subscription check failed for %s: %s", user_id, exc)
        return False
    return member.status in ALLOWED_MEMBER_STATUSES


async def gate(message: Message, bot: Bot, ctx: Context) -> bool:
    if not message.from_user:
        return False
    if await is_subscribed(bot, ctx, message.from_user.id):
        return True
    await message.answer(
        texts.SUBSCRIBE_REQUIRED,
        reply_markup=subscribe_kb(ctx.settings.required_channel_url),
    )
    return False


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #

@router.message(CommandStart())
async def cmd_start(message: Message, bot: Bot, ctx: Context) -> None:
    if not await gate(message, bot, ctx):
        return
    await message.answer(texts.START)


@router.message(Command("help"))
async def cmd_help(message: Message, bot: Bot, ctx: Context) -> None:
    if not await gate(message, bot, ctx):
        return
    await message.answer(texts.HELP)


@router.message(Command("status"))
async def cmd_status(message: Message, bot: Bot, ctx: Context) -> None:
    if not await gate(message, bot, ctx):
        return
    survey = await ctx.cobalt.survey()

    lines = ["<b>Инстансы Cobalt</b>"]
    youtube_anywhere = False
    for index, probe in enumerate(survey, 1):
        role = "основной" if index == 1 else "запасной"
        if not probe.ok:
            lines.append(f"❌ <code>{probe.endpoint.label}</code> — {probe.error} ({role})")
            continue
        youtube_anywhere = youtube_anywhere or probe.supports_youtube
        lines.append(
            f"{'✅' if probe.endpoint.healthy else '⚠️'} <code>{probe.endpoint.label}</code> — "
            f"v{probe.version or '?'}, площадок: {len(probe.services)}"
            f"{', с YouTube' if probe.supports_youtube else ', без YouTube'} ({role})"
        )

    if ctx.settings.ytdlp_for_youtube:
        version = ytdlp.version()
        lines.append(
            f"\n🎬 YouTube: <b>yt-dlp</b> {'v' + version if version else '— не установлен ❌'}"
            + (", Cobalt как запасной" if ctx.settings.ytdlp_fallback_to_cobalt else "")
        )
    elif not youtube_anywhere:
        lines.append("\n⚠️ YouTube через yt-dlp выключен, а инстансы его не поддерживают.")

    settings = ctx.settings
    if settings.telegram_api_url:
        lines.append(
            f"\n📤 Локальный Bot API: <code>{settings.telegram_api_url}</code>\n"
            f"Лимит отправки: <b>{settings.max_download_mb} МБ</b> (потолок 2000)"
        )
    elif settings.limit_exceeds_telegram:
        lines.append(
            f"\n⚠️ MAX_DOWNLOAD_MB={settings.max_download_mb}, но облачный Bot API "
            f"примет только <b>50 МБ</b> — файлы крупнее Telegram отклонит."
        )
    else:
        lines.append(f"\nЛимит отправки: <b>{settings.max_download_mb} МБ</b>")
    await message.answer("\n".join(lines))


@router.callback_query(F.data == "sub:check")
async def cb_check_subscription(call: CallbackQuery, bot: Bot, ctx: Context) -> None:
    if await is_subscribed(bot, ctx, call.from_user.id):
        if isinstance(call.message, Message):
            with suppress(TelegramBadRequest):
                await call.message.edit_text(texts.SUBSCRIBE_OK)
        await call.answer()
    else:
        await call.answer(texts.SUBSCRIBE_MISSING, show_alert=True)


# --------------------------------------------------------------------------- #
# link intake
# --------------------------------------------------------------------------- #

def extract_url(message: Message) -> str | None:
    for entity in message.entities or []:
        if entity.type == "url" and message.text:
            return entity.extract_from(message.text)
        if entity.type == "text_link" and entity.url:
            return entity.url
    match = URL_RE.search(message.text or "")
    return match.group(0) if match else None


@router.message(F.text, ~F.text.startswith("/"))
async def on_link(message: Message, bot: Bot, ctx: Context) -> None:
    if not await gate(message, bot, ctx):
        return

    url = extract_url(message)
    if not url:
        await message.answer(texts.NOT_A_LINK)
        return

    token = ctx.links.put(url)
    await message.answer(
        texts.CHOOSE_ACTION,
        reply_markup=actions_kb(token, ctx.settings.video_quality),
    )


@router.callback_query(F.data.startswith("q:"))
async def cb_quality_menu(call: CallbackQuery) -> None:
    token = (call.data or "q:").split(":", 1)[1]
    if not isinstance(call.message, Message):
        await call.answer(texts.LINK_EXPIRED, show_alert=True)
        return
    with suppress(TelegramBadRequest):
        await call.message.edit_text(texts.CHOOSE_QUALITY, reply_markup=quality_kb(token))
    await call.answer()


@router.callback_query(F.data.startswith("dl:"))
async def cb_download(call: CallbackQuery, bot: Bot, ctx: Context) -> None:
    payload = DownloadCallback.unpack(call.data or "")
    if payload is None:
        await call.answer()
        return

    status = call.message
    if not isinstance(status, Message):
        # Message is too old for the bot to edit (InaccessibleMessage).
        await call.answer(texts.LINK_EXPIRED, show_alert=True)
        return

    url = ctx.links.get(payload.token)
    if url is None:
        await call.answer(texts.LINK_EXPIRED, show_alert=True)
        return

    if not ctx.cooldown.acquire(call.from_user.id):
        await call.answer(texts.BUSY, show_alert=True)
        return

    await call.answer()
    with suppress(TelegramBadRequest):
        await status.edit_text(texts.QUEUED, reply_markup=None)

    try:
        async with ctx.slots:
            await run_job(
                bot=bot,
                ctx=ctx,
                chat_id=status.chat.id,
                status=status,
                url=url,
                token=payload.token,
                mode=payload.mode,
                quality=payload.quality,
            )
    finally:
        ctx.cooldown.release(call.from_user.id)


# --------------------------------------------------------------------------- #
# download pipeline
# --------------------------------------------------------------------------- #

async def edit(status: Message, text: str, markup: InlineKeyboardMarkup | None = None) -> None:
    """Progress updates are cosmetic: never let a failed edit kill a job."""
    try:
        await status.edit_text(text, reply_markup=markup)
    except TelegramRetryAfter as exc:
        await asyncio.sleep(exc.retry_after)
        with suppress(TelegramBadRequest, TelegramRetryAfter):
            await status.edit_text(text, reply_markup=markup)
    except TelegramBadRequest:
        pass


async def run_job(
    *,
    bot: Bot,
    ctx: Context,
    chat_id: int,
    status: Message,
    url: str,
    token: str,
    mode: str,
    quality: str,
) -> None:
    settings = ctx.settings
    effective_quality = quality if quality != "-" else settings.video_quality

    if settings.ytdlp_for_youtube and ytdlp.is_youtube(url):
        handled = await run_ytdlp_job(
            bot=bot,
            ctx=ctx,
            chat_id=chat_id,
            status=status,
            url=url,
            token=token,
            mode=mode,
            quality=effective_quality,
        )
        if handled:
            return
        # yt-dlp could not do it and the fallback is on: let Cobalt try.
        await edit(status, texts.YTDLP_FALLBACK)

    async def ask(local_processing: str) -> CobaltResult:
        return await ctx.cobalt.process(
            url,
            download_mode="audio" if mode == MODE_AUDIO else "auto",
            video_quality=effective_quality,
            audio_format=settings.audio_format,
            audio_bitrate=settings.audio_bitrate,
            youtube_video_codec=settings.youtube_video_codec,
            youtube_better_audio=settings.youtube_better_audio,
            local_processing=local_processing,
            always_proxy=settings.always_proxy,
        )

    await edit(status, texts.FETCHING)
    try:
        result = await ask("disabled")
    except CobaltError as exc:
        log.info("Cobalt refused %s: %s %s", url, exc.code, exc.context)
        await edit(status, texts.cobalt_error(exc.code))
        return
    except CobaltUnavailable as exc:
        log.error("Cobalt unavailable: %s", exc)
        await edit(status, texts.COBALT_ERRORS["error.api.unreachable"])
        return
    except asyncio.TimeoutError:
        await edit(status, texts.TIMEOUT)
        return

    try:
        with tempfile.TemporaryDirectory(prefix="cobalt-") as tmp:
            work_dir = Path(tmp)
            if result.status == STATUS_PICKER:
                await send_picker(bot, ctx, chat_id, status, result, work_dir)
                return

            try:
                path = await materialize(ctx, status, result, work_dir, mode)
            except EmptyDownload:
                # Server-side muxing died mid-stream. Ask for the raw tracks
                # and put them together ourselves.
                log.warning("Empty tunnel for %s, retrying with local processing", url)
                await edit(status, texts.RETRY_LOCAL)
                for leftover in work_dir.iterdir():
                    leftover.unlink(missing_ok=True)
                result = await ask("preferred")
                path = await materialize(ctx, status, result, work_dir, mode)

            if path is None:
                return

            await edit(status, texts.UPLOADING)
            await send_media(bot, ctx, chat_id, path, mode, work_dir)

        with suppress(TelegramBadRequest):
            await status.delete()

    except FileTooLarge as exc:
        size_mb = exc.size_bytes / 1024 / 1024 if exc.size_bytes else None
        await edit(
            status,
            texts.too_large(size_mb, settings.max_download_mb),
            fallback_kb(token, effective_quality),
        )
    except TelegramEntityTooLarge:
        await edit(
            status,
            texts.too_large(None, settings.upload_limit_mb),
            fallback_kb(token, effective_quality),
        )
    except EmptyDownload:
        log.error("Cobalt returned an empty file for %s even with local processing", url)
        await edit(status, texts.EMPTY_FILE)
    except CobaltError as exc:
        log.info("Cobalt refused the local-processing retry for %s: %s", url, exc.code)
        await edit(status, texts.cobalt_error(exc.code))
    except CobaltUnavailable:
        await edit(status, texts.COBALT_ERRORS["error.api.unreachable"])
    except asyncio.TimeoutError:
        await edit(status, texts.TIMEOUT)
    except (aiohttp.ClientError, OSError, RuntimeError) as exc:
        log.exception("Job failed for %s", url)
        await edit(status, texts.UNKNOWN_ERROR.format(error=str(exc)[:300]))


async def report_progress(status: Message, progress: ytdlp.Progress) -> None:
    """Edits the status message while yt-dlp streams, at most once per 4s."""
    last: int | None = None
    while True:
        await asyncio.sleep(4)
        percent = progress.percent
        if percent is not None and percent != last:
            last = percent
            await edit(status, f"{texts.DOWNLOADING} {percent}%")


async def run_ytdlp_job(
    *,
    bot: Bot,
    ctx: Context,
    chat_id: int,
    status: Message,
    url: str,
    token: str,
    mode: str,
    quality: str,
) -> bool:
    """Returns True when the job is finished (sent, or failed for good)."""
    settings = ctx.settings
    await edit(status, texts.YTDLP_WORKING)

    progress = ytdlp.Progress()
    reporter: asyncio.Task[None] | None = None

    try:
        with tempfile.TemporaryDirectory(prefix="ytdlp-") as tmp:
            work_dir = Path(tmp)
            reporter = asyncio.create_task(report_progress(status, progress))
            result = await ytdlp.download(
                url,
                work_dir,
                mode="audio" if mode == MODE_AUDIO else "video",
                quality=quality,
                limit_bytes=settings.max_download_bytes,
                audio_format=settings.audio_format,
                audio_bitrate=settings.audio_bitrate,
                cookies_file=settings.ytdlp_cookies_file,
                prefer_h264=settings.youtube_video_codec == "h264",
                progress=progress,
            )
            reporter.cancel()

            await edit(status, texts.UPLOADING)
            await send_media(bot, ctx, chat_id, result.path, mode, work_dir)

        with suppress(TelegramBadRequest):
            await status.delete()
        return True

    except ytdlp.YtDlpTooLarge as exc:
        size_mb = exc.size_bytes / 1024 / 1024 if exc.size_bytes else None
        await edit(
            status,
            texts.too_large(size_mb, settings.max_download_mb),
            fallback_kb(token, quality),
        )
        return True

    except TelegramEntityTooLarge:
        await edit(
            status,
            texts.too_large(None, settings.upload_limit_mb),
            fallback_kb(token, quality),
        )
        return True

    except (ytdlp.YtDlpError, ytdlp.YtDlpUnavailable, OSError) as exc:
        hint = getattr(exc, "hint", str(exc))
        log.warning("yt-dlp failed for %s: %s", url, exc)
        if settings.ytdlp_fallback_to_cobalt:
            return False
        await edit(status, hint)
        return True

    finally:
        if reporter is not None:
            reporter.cancel()
            with suppress(asyncio.CancelledError):
                await reporter


async def materialize(
    ctx: Context,
    status: Message,
    result: CobaltResult,
    work_dir: Path,
    mode: str,
) -> Path | None:
    """Turn a Cobalt answer into a single file on disk."""
    limit = ctx.settings.max_download_bytes
    session = ctx.cobalt.session

    if result.status == STATUS_LOCAL_PROCESSING:
        # The instance handed us raw tracks; mux them ourselves with ffmpeg.
        if not result.tunnels:
            await edit(status, texts.UNKNOWN_ERROR.format(error="Cobalt не вернул потоки"))
            return None

        await edit(status, texts.DOWNLOADING)
        parts: list[Path] = []
        for index, tunnel in enumerate(result.tunnels):
            parts.append(
                await download_file(
                    session,
                    tunnel,
                    work_dir,
                    limit_bytes=limit,
                    fallback_name=f"part{index}.bin",
                )
            )

        if len(parts) == 1:
            return parts[0]

        target = work_dir / safe_filename(
            result.output_filename, "video.mp4" if mode != MODE_AUDIO else "audio.m4a"
        )
        if target.suffix.lower() not in {".mp4", ".mkv", ".webm", ".m4a"}:
            target = target.with_suffix(".mp4")
        if target in parts:
            target = work_dir / f"muxed{target.suffix}"
        await edit(status, "🧩 Собираю видео и звук...")
        return await media.mux(parts, target)

    if not result.url:
        await edit(status, texts.UNKNOWN_ERROR.format(error="Cobalt не вернул ссылку"))
        return None

    await edit(status, texts.DOWNLOADING)
    fallback = "audio.mp3" if mode == MODE_AUDIO else "video.mp4"
    return await download_file(
        session,
        result.url,
        work_dir,
        limit_bytes=limit,
        fallback_name=safe_filename(result.filename, fallback),
    )


async def send_media(
    bot: Bot,
    ctx: Context,
    chat_id: int,
    path: Path,
    mode: str,
    work_dir: Path,
    caption: str | None = None,
) -> None:
    kind = "audio" if mode == MODE_AUDIO else media.kind_of(path)
    info = await media.probe(path)
    file = FSInputFile(path, filename=path.name)

    if kind == "video":
        thumb_path = await media.make_thumbnail(path, work_dir / f"{path.stem}_thumb.jpg")
        await bot.send_chat_action(chat_id, "upload_video")
        await bot.send_video(
            chat_id,
            file,
            caption=caption,
            duration=info.duration,
            width=info.width,
            height=info.height,
            thumbnail=FSInputFile(thumb_path) if thumb_path else None,
            supports_streaming=True,
        )
    elif kind == "audio":
        await bot.send_chat_action(chat_id, "upload_document")
        await bot.send_audio(
            chat_id,
            file,
            caption=caption,
            duration=info.duration,
            title=info.title or path.stem,
            performer=info.artist,
        )
    elif kind == "photo":
        await bot.send_chat_action(chat_id, "upload_photo")
        await bot.send_photo(chat_id, file, caption=caption)
    elif kind == "animation":
        await bot.send_animation(chat_id, file, caption=caption)
    else:
        await bot.send_chat_action(chat_id, "upload_document")
        await bot.send_document(chat_id, file, caption=caption)


async def send_picker(
    bot: Bot,
    ctx: Context,
    chat_id: int,
    status: Message,
    result: CobaltResult,
    work_dir: Path,
) -> None:
    items = result.picker[:MAX_PICKER_ITEMS]
    await edit(status, f"⬇️ Скачиваю {len(items)} файл(ов)...")

    limit = ctx.settings.max_download_bytes
    session = ctx.cobalt.session
    album: list[Path] = []
    extras: list[Path] = []
    skipped = 0

    for index, item in enumerate(items, 1):
        suffix = {"photo": ".jpg", "video": ".mp4", "gif": ".gif"}.get(item.type, ".bin")
        try:
            path = await download_file(
                session,
                item.url,
                work_dir,
                limit_bytes=limit,
                fallback_name=f"media_{index}{suffix}",
            )
        except (FileTooLarge, EmptyDownload):
            skipped += 1
            continue

        (extras if item.type == "gif" else album).append(path)

    if result.audio_url:
        with suppress(FileTooLarge, EmptyDownload, aiohttp.ClientError):
            extras.append(
                await download_file(
                    session,
                    result.audio_url,
                    work_dir,
                    limit_bytes=limit,
                    fallback_name=safe_filename(result.audio_filename, "audio.mp3"),
                )
            )

    await edit(status, texts.UPLOADING)

    for chunk_start in range(0, len(album), 10):
        chunk = album[chunk_start : chunk_start + 10]
        if len(chunk) == 1:
            await send_media(bot, ctx, chat_id, chunk[0], MODE_VIDEO, work_dir)
            continue

        builder = MediaGroupBuilder()
        for path in chunk:
            kind = media.kind_of(path)
            file = FSInputFile(path, filename=path.name)
            if kind == "photo":
                builder.add_photo(media=file)
            elif kind == "video":
                builder.add_video(media=file)
            else:
                builder.add_document(media=file)
        try:
            await bot.send_media_group(chat_id, media=builder.build())
        except TelegramRetryAfter as exc:
            await asyncio.sleep(exc.retry_after)
            await bot.send_media_group(chat_id, media=builder.build())

    for path in extras:
        await send_media(bot, ctx, chat_id, path, MODE_VIDEO, work_dir)

    if skipped:
        await edit(status, f"⚠️ {skipped} файл(ов) пропущено — больше лимита.")
    else:
        with suppress(TelegramBadRequest):
            await status.delete()
