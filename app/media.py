"""ffprobe/ffmpeg helpers: metadata, thumbnails and local muxing."""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

FFPROBE = shutil.which("ffprobe")
FFMPEG = shutil.which("ffmpeg")

VIDEO_SUFFIXES = {".mp4", ".mkv", ".webm", ".mov", ".m4v"}
AUDIO_SUFFIXES = {".mp3", ".m4a", ".ogg", ".opus", ".wav", ".flac"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


@dataclass(slots=True)
class MediaInfo:
    duration: int | None = None
    width: int | None = None
    height: int | None = None
    title: str | None = None
    artist: str | None = None


async def _run(*args: str, timeout: int = 120) -> tuple[int, bytes, bytes]:
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise
    return process.returncode or 0, stdout, stderr


async def probe(path: Path) -> MediaInfo:
    """Best-effort metadata; never raises, an empty MediaInfo is fine for Telegram."""
    if not FFPROBE:
        return MediaInfo()

    try:
        code, stdout, _ = await _run(
            FFPROBE,
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            str(path),
            timeout=60,
        )
        if code != 0:
            return MediaInfo()
        data = json.loads(stdout or b"{}")
    except Exception as exc:  # noqa: BLE001 - metadata is optional
        log.debug("ffprobe failed for %s: %s", path.name, exc)
        return MediaInfo()

    fmt = data.get("format") or {}
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}

    duration = None
    raw_duration = fmt.get("duration")
    if raw_duration:
        try:
            duration = int(float(raw_duration))
        except (TypeError, ValueError):
            duration = None

    width = height = None
    for stream in data.get("streams") or []:
        if stream.get("codec_type") == "video":
            width = stream.get("width")
            height = stream.get("height")
            break

    return MediaInfo(
        duration=duration,
        width=width,
        height=height,
        title=tags.get("title"),
        artist=tags.get("artist"),
    )


async def make_thumbnail(path: Path, dest: Path, *, at_second: int = 1) -> Path | None:
    """Grab a single frame so Telegram shows a preview instead of a grey box."""
    if not FFMPEG:
        return None
    try:
        code, _, stderr = await _run(
            FFMPEG,
            "-y",
            "-ss", str(max(0, at_second)),
            "-i", str(path),
            "-frames:v", "1",
            "-vf", "scale='min(320,iw)':-2",
            "-q:v", "5",
            str(dest),
            timeout=90,
        )
    except asyncio.TimeoutError:
        log.debug("Thumbnail extraction timed out for %s", path.name)
        return None

    if code != 0 or not dest.exists() or dest.stat().st_size == 0:
        log.debug("Thumbnail extraction failed for %s: %s", path.name, stderr[-200:])
        return None
    return dest


async def _try_mux(parts: list[Path], dest: Path, audio_args: list[str]) -> bytes | None:
    """Runs one ffmpeg attempt; returns stderr on failure, None on success."""
    args: list[str] = [FFMPEG, "-y"]
    for part in parts:
        args += ["-i", str(part)]
    args += ["-c:v", "copy", *audio_args, "-movflags", "+faststart", str(dest)]

    code, _, stderr = await _run(*args, timeout=900)
    if code == 0 and dest.exists() and dest.stat().st_size > 0:
        return None
    dest.unlink(missing_ok=True)
    return stderr


async def mux(parts: list[Path], dest: Path) -> Path:
    """Join separate video/audio tracks (`local-processing`), re-encoding audio only if forced."""
    if not FFMPEG:
        raise RuntimeError("ffmpeg is not installed in the container")

    stderr = await _try_mux(parts, dest, ["-c:a", "copy"])
    if stderr is None:
        return dest

    # Opus cannot live in an mp4 container: transcode just the audio.
    log.info("Stream copy failed for %s, re-encoding audio to aac", dest.name)
    stderr = await _try_mux(parts, dest, ["-c:a", "aac", "-b:a", "192k"])
    if stderr is None:
        return dest

    # Last resort: mkv swallows any codec combination.
    mkv = dest.with_suffix(".mkv")
    stderr = await _try_mux(parts, mkv, ["-c:a", "copy"])
    if stderr is None:
        return mkv

    raise RuntimeError(f"ffmpeg mux failed: {stderr[-300:].decode(errors='replace')}")


def kind_of(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in VIDEO_SUFFIXES:
        return "video"
    if suffix in AUDIO_SUFFIXES:
        return "audio"
    if suffix in IMAGE_SUFFIXES:
        return "photo"
    if suffix == ".gif":
        return "animation"
    return "document"
