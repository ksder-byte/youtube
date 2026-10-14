"""YouTube downloads through yt-dlp, bypassing Cobalt entirely.

yt-dlp fetches its own PO tokens, so this path does not need the
`yt-session-generator` container at all — which is the whole point of having
it: when Cobalt's YouTube session breaks, this keeps working.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

log = logging.getLogger(__name__)

YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}


class YtDlpError(RuntimeError):
    """yt-dlp refused the link; `hint` is already user-facing Russian."""

    def __init__(self, hint: str, raw: str = "") -> None:
        super().__init__(hint)
        self.hint = hint
        self.raw = raw


class YtDlpTooLarge(RuntimeError):
    def __init__(self, size_bytes: int | None, limit_bytes: int) -> None:
        super().__init__("file exceeds the configured limit")
        self.size_bytes = size_bytes
        self.limit_bytes = limit_bytes


class YtDlpUnavailable(RuntimeError):
    """The library is not installed in this image."""


def is_youtube(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host in YOUTUBE_HOSTS


# Messages yt-dlp produces, mapped to something a bot user can act on.
ERROR_HINTS: tuple[tuple[str, str], ...] = (
    ("confirm you're not a bot", "❌ YouTube требует подтверждения, что вы не бот. "
                                 "Помогает файл cookies (<code>YTDLP_COOKIES_FILE</code>)."),
    ("sign in to confirm your age", "❌ Ролик с возрастным ограничением — нужен вход в аккаунт."),
    ("private video", "❌ Видео приватное."),
    ("video unavailable", "❌ Видео недоступно."),
    ("removed by the uploader", "❌ Видео удалено автором."),
    ("has been terminated", "❌ Канал заблокирован."),
    ("live event will begin", "❌ Трансляция ещё не началась."),
    ("is live", "❌ Идущие прямые эфиры скачать нельзя."),
    ("not available in your country", "❌ Видео недоступно в регионе сервера."),
    ("members-only", "❌ Видео только для спонсоров канала."),
    ("requested format is not available", "❌ Нет подходящего формата — попробуйте другое качество."),
    ("unable to download webpage", "❌ Не удалось достучаться до YouTube. Проверьте сеть сервера."),
)


def explain(message: str) -> str:
    lowered = message.lower()
    for needle, hint in ERROR_HINTS:
        if needle in lowered:
            return hint
    return f"❌ yt-dlp не смог скачать: <code>{message[:200]}</code>"


@dataclass(slots=True)
class YtDlpResult:
    path: Path
    title: str | None = None
    duration: int | None = None
    width: int | None = None
    height: int | None = None
    uploader: str | None = None


@dataclass(slots=True)
class Progress:
    """Filled by yt-dlp's hook thread, read by the async status updater."""

    downloaded: int = 0
    total: int | None = None
    finished: bool = False

    @property
    def percent(self) -> int | None:
        if not self.total:
            return None
        return min(100, int(self.downloaded * 100 / self.total))


def build_format(mode: str, quality: str, prefer_h264: bool = True) -> str:
    """Format selector: h264+m4a keeps Telegram's player happy."""
    if mode == "audio":
        return "bestaudio/best"

    height = "" if quality == "max" else f"[height<={quality}]"
    if prefer_h264:
        return (
            f"bestvideo{height}[vcodec^=avc1]+bestaudio[ext=m4a]/"
            f"bestvideo{height}+bestaudio/"
            f"best{height}/best"
        )
    return f"bestvideo{height}+bestaudio/best{height}/best"


def build_options(
    dest_dir: Path,
    *,
    mode: str,
    quality: str,
    limit_bytes: int,
    audio_format: str = "mp3",
    audio_bitrate: str = "128",
    cookies_file: str | None = None,
    prefer_h264: bool = True,
) -> dict[str, Any]:
    options: dict[str, Any] = {
        "format": build_format(mode, quality, prefer_h264),
        "outtmpl": str(dest_dir / "%(title).80B.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 3,
        "fragment_retries": 5,
        "concurrent_fragment_downloads": 4,
        "max_filesize": limit_bytes,
        "restrictfilenames": False,
        "windowsfilenames": True,
        "overwrites": True,
        "trim_file_name": 80,
    }

    if mode == "audio":
        options["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": audio_format if audio_format != "best" else "mp3",
                "preferredquality": audio_bitrate,
            }
        ]
    else:
        options["merge_output_format"] = "mp4"

    if cookies_file:
        options["cookiefile"] = cookies_file

    return options


def _pick_size(info: dict[str, Any]) -> int | None:
    """Size of what will actually be downloaded, including merged formats."""
    for key in ("filesize", "filesize_approx"):
        value = info.get(key)
        if value:
            return int(value)

    total = 0
    for fmt in info.get("requested_formats") or []:
        size = fmt.get("filesize") or fmt.get("filesize_approx")
        if not size:
            return None
        total += int(size)
    return total or None


def _download_sync(
    url: str,
    options: dict[str, Any],
    progress: Progress,
    limit_bytes: int,
    ytdl_factory: Callable[[dict[str, Any]], Any] | None = None,
) -> YtDlpResult:
    if ytdl_factory is None:
        try:
            from yt_dlp import YoutubeDL
        except ImportError as exc:  # pragma: no cover - image always ships it
            raise YtDlpUnavailable("yt-dlp is not installed") from exc

        ytdl_factory = YoutubeDL

    def hook(status: dict[str, Any]) -> None:
        if status.get("status") == "downloading":
            progress.downloaded = status.get("downloaded_bytes") or 0
            progress.total = (
                status.get("total_bytes") or status.get("total_bytes_estimate") or progress.total
            )
        elif status.get("status") == "finished":
            progress.finished = True

    options = {**options, "progress_hooks": [hook]}

    with ytdl_factory(options) as ytdl:
        try:
            info = ytdl.extract_info(url, download=False)
        except Exception as exc:  # noqa: BLE001 - yt-dlp raises its own types
            raise YtDlpError(explain(str(exc)), str(exc)) from exc

        if info is None:
            raise YtDlpError("❌ yt-dlp ничего не нашёл по этой ссылке.")

        # Playlists are out of scope: take the first entry of a mix, nothing else.
        if info.get("_type") == "playlist":
            entries = [entry for entry in (info.get("entries") or []) if entry]
            if not entries:
                raise YtDlpError("❌ В плейлисте нет доступных видео.")
            info = entries[0]

        size = _pick_size(info)
        if size and size > limit_bytes:
            raise YtDlpTooLarge(size, limit_bytes)

        try:
            info = ytdl.extract_info(url, download=True)
        except Exception as exc:  # noqa: BLE001
            message = str(exc)
            if "larger than max-filesize" in message.lower():
                raise YtDlpTooLarge(None, limit_bytes) from exc
            raise YtDlpError(explain(message), message) from exc

        if info.get("_type") == "playlist":
            info = [entry for entry in (info.get("entries") or []) if entry][0]

        path = Path(ytdl.prepare_filename(info))

    if not path.exists():
        # Postprocessors rename the file (mp3 extraction, remux); find the result.
        candidates = sorted(
            (p for p in path.parent.iterdir() if p.is_file() and p.stat().st_size > 0),
            key=lambda p: p.stat().st_mtime,
        )
        if not candidates:
            raise YtDlpError("❌ yt-dlp завершился, но файла нет.")
        path = candidates[-1]

    if path.stat().st_size == 0:
        path.unlink(missing_ok=True)
        raise YtDlpError("❌ yt-dlp скачал пустой файл.")

    if path.stat().st_size > limit_bytes:
        raise YtDlpTooLarge(path.stat().st_size, limit_bytes)

    return YtDlpResult(
        path=path,
        title=info.get("title"),
        duration=int(info["duration"]) if info.get("duration") else None,
        width=info.get("width"),
        height=info.get("height"),
        uploader=info.get("uploader"),
    )


async def download(
    url: str,
    dest_dir: Path,
    *,
    mode: str,
    quality: str,
    limit_bytes: int,
    audio_format: str = "mp3",
    audio_bitrate: str = "128",
    cookies_file: str | None = None,
    prefer_h264: bool = True,
    progress: Progress | None = None,
    ytdl_factory: Callable[[dict[str, Any]], Any] | None = None,
) -> YtDlpResult:
    """Runs the blocking yt-dlp work in a worker thread."""
    options = build_options(
        dest_dir,
        mode=mode,
        quality=quality,
        limit_bytes=limit_bytes,
        audio_format=audio_format,
        audio_bitrate=audio_bitrate,
        cookies_file=cookies_file,
        prefer_h264=prefer_h264,
    )
    return await asyncio.to_thread(
        _download_sync, url, options, progress or Progress(), limit_bytes, ytdl_factory
    )


def version() -> str | None:
    try:
        from yt_dlp import version as ytdlp_version
    except ImportError:
        return None
    return ytdlp_version.__version__
