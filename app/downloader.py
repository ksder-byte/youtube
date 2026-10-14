"""Streaming downloads with a hard size limit, straight to disk."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from urllib.parse import unquote, urlparse

import aiohttp

log = logging.getLogger(__name__)

CHUNK_SIZE = 1024 * 256
_UNSAFE = re.compile(r"[^\w\-. ()\[\]]+", re.UNICODE)


class FileTooLarge(RuntimeError):
    def __init__(self, size_bytes: int | None, limit_bytes: int) -> None:
        super().__init__("file exceeds the configured limit")
        self.size_bytes = size_bytes
        self.limit_bytes = limit_bytes


class EmptyDownload(RuntimeError):
    """The server answered 200 but sent no bytes.

    Cobalt does this when its own remux dies after the response headers are
    already on the wire: the tunnel just ends. Telegram rejects such a file
    with "file must be non-empty", so we catch it here instead.
    """

    def __init__(self, url: str) -> None:
        super().__init__("server returned an empty body")
        self.url = url


def safe_filename(name: str | None, fallback: str = "download.bin") -> str:
    """Strip directories and exotic characters so the name is safe on disk."""
    if not name:
        return fallback
    name = unquote(name).replace("\\", "/")
    name = Path(name).name
    name = _UNSAFE.sub("_", name).strip(" ._")
    if not name:
        return fallback
    # Keep room for the suffix while staying well under filesystem limits.
    if len(name) > 120:
        stem, dot, suffix = name.rpartition(".")
        name = (stem[:110] + dot + suffix) if dot else name[:120]
    return name


def _name_from_headers(resp: aiohttp.ClientResponse) -> str | None:
    disposition = resp.headers.get("Content-Disposition", "")
    match = re.search(r"filename\*=UTF-8''([^;]+)", disposition) or re.search(
        r'filename="?([^";]+)"?', disposition
    )
    if match:
        return match.group(1)
    path = urlparse(str(resp.url)).path
    candidate = Path(path).name
    return candidate or None


async def download_file(
    session: aiohttp.ClientSession,
    url: str,
    dest_dir: Path,
    *,
    limit_bytes: int,
    fallback_name: str = "download.bin",
) -> Path:
    """Download `url` into `dest_dir`, aborting as soon as `limit_bytes` is passed."""
    async with session.get(url) as resp:
        resp.raise_for_status()

        declared = resp.headers.get("Content-Length")
        if declared and declared.isdigit() and int(declared) > limit_bytes:
            raise FileTooLarge(int(declared), limit_bytes)

        name = safe_filename(_name_from_headers(resp) or fallback_name, fallback_name)
        if not Path(name).suffix:
            name = f"{name}{Path(fallback_name).suffix or '.bin'}"

        dest = dest_dir / name
        written = 0
        with dest.open("wb") as fh:
            async for chunk in resp.content.iter_chunked(CHUNK_SIZE):
                written += len(chunk)
                if written > limit_bytes:
                    fh.close()
                    dest.unlink(missing_ok=True)
                    raise FileTooLarge(None, limit_bytes)
                fh.write(chunk)

        if written == 0:
            dest.unlink(missing_ok=True)
            log.warning(
                "Empty body from %s (HTTP %s, content-type %r)",
                url,
                resp.status,
                resp.headers.get("Content-Type"),
            )
            raise EmptyDownload(url)

    log.info("Downloaded %s (%s bytes)", dest.name, f"{written:,}")
    return dest
