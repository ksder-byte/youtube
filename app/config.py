"""Runtime configuration, loaded once from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlparse

from dotenv import load_dotenv

from .cobalt import Endpoint

load_dotenv()

VIDEO_QUALITIES = ("144", "240", "360", "480", "720", "1080", "1440", "2160", "max")
AUDIO_FORMATS = ("best", "mp3", "ogg", "wav", "opus")
YOUTUBE_CODECS = ("h264", "av1", "vp9")


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None:
        # A .env saved by PowerShell's Set-Content is UTF-8 *with BOM*, and the
        # BOM glues itself to the first variable name: BOT_TOKEN arrives as
        # "\ufeffBOT_TOKEN". Nobody should have to debug that.
        value = os.environ.get(f"\ufeff{name}", default)
    if value is None:
        return None
    value = value.strip().strip("\ufeff")
    return value or None


def _int(name: str, default: int) -> int:
    raw = _env(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:  # pragma: no cover - config error path
        raise RuntimeError(f"{name} must be an integer, got {raw!r}") from exc


def _bool(name: str, default: bool) -> bool:
    raw = _env(name)
    if raw is None:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def _choice(name: str, default: str, allowed: tuple[str, ...]) -> str:
    value = (_env(name) or default).lower()
    if value not in allowed:
        raise RuntimeError(f"{name} must be one of {', '.join(allowed)}, got {value!r}")
    return value


def _endpoints(name: str, default: str, api_key: str | None) -> tuple[Endpoint, ...]:
    """Parses a list of instances: `url`, `url|apikey`, comma or newline separated.

    The first entry is the primary one; the rest are only used when it cannot
    deliver. Put your own instance first — public ones see every link your
    users send.
    """
    raw = _env(name) or default
    seen: dict[str, Endpoint] = {}
    for chunk in raw.replace("\n", ",").split(","):
        item = chunk.strip()
        if not item:
            continue
        url, _, key = item.partition("|")
        url = url.strip().rstrip("/")
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise RuntimeError(f"{name} contains an invalid URL: {item!r}")
        if url not in seen:
            seen[url] = Endpoint(url=url, api_key=key.strip() or api_key)
    if not seen:
        raise RuntimeError(f"{name} is empty")
    return tuple(seen.values())


@dataclass(frozen=True, slots=True)
class Settings:
    bot_token: str
    cobalt_endpoints: tuple[Endpoint, ...]
    cobalt_api_key: str | None
    required_channel: str | None
    required_channel_url: str | None
    max_download_mb: int
    video_quality: str
    audio_format: str
    audio_bitrate: str
    youtube_video_codec: str
    youtube_better_audio: bool
    always_proxy: bool
    ytdlp_for_youtube: bool
    ytdlp_fallback_to_cobalt: bool
    ytdlp_cookies_file: str | None
    telegram_api_url: str | None
    telegram_api_local: bool
    telegram_timeout: int
    max_concurrent_downloads: int
    api_timeout: int
    download_timeout: int
    log_level: str

    @property
    def max_download_bytes(self) -> int:
        return self.max_download_mb * 1024 * 1024

    @property
    def cobalt_api_url(self) -> str:
        return self.cobalt_endpoints[0].url

    @property
    def upload_limit_mb(self) -> int:
        """What Telegram itself will accept, whatever MAX_DOWNLOAD_MB says.

        The cloud Bot API caps a bot upload at 50 MB; a local Bot API server
        raises that to 2000 MB.
        """
        return 2000 if self.telegram_api_url else 50

    @property
    def limit_exceeds_telegram(self) -> bool:
        return self.max_download_mb > self.upload_limit_mb

    @property
    def subscription_required(self) -> bool:
        return bool(self.required_channel)


def load_settings() -> Settings:
    token = _env("BOT_TOKEN")
    if not token:
        raise RuntimeError(
            "BOT_TOKEN is not set. Copy .env.example to .env and put the @BotFather token there."
        )

    api_key = _env("COBALT_API_KEY")
    max_download_mb = _int("MAX_DOWNLOAD_MB", 50)
    if max_download_mb < 1:
        raise RuntimeError("MAX_DOWNLOAD_MB must be >= 1")

    return Settings(
        bot_token=token,
        cobalt_endpoints=_endpoints("COBALT_API_URL", "http://cobalt:9000", api_key),
        cobalt_api_key=api_key,
        required_channel=_env("REQUIRED_CHANNEL"),
        required_channel_url=_env("REQUIRED_CHANNEL_URL"),
        max_download_mb=max_download_mb,
        video_quality=_choice("VIDEO_QUALITY", "1080", VIDEO_QUALITIES),
        audio_format=_choice("AUDIO_FORMAT", "mp3", AUDIO_FORMATS),
        audio_bitrate=_env("AUDIO_BITRATE") or "128",
        youtube_video_codec=_choice("YOUTUBE_VIDEO_CODEC", "h264", YOUTUBE_CODECS),
        youtube_better_audio=_bool("YOUTUBE_BETTER_AUDIO", False),
        always_proxy=_bool("ALWAYS_PROXY", True),
        ytdlp_for_youtube=_bool("YTDLP_FOR_YOUTUBE", True),
        ytdlp_fallback_to_cobalt=_bool("YTDLP_FALLBACK_TO_COBALT", False),
        ytdlp_cookies_file=_env("YTDLP_COOKIES_FILE"),
        telegram_api_url=(_env("TELEGRAM_API_URL") or "").rstrip("/") or None,
        telegram_api_local=_bool("TELEGRAM_API_LOCAL_MODE", True),
        telegram_timeout=_int("TELEGRAM_TIMEOUT", 900),
        max_concurrent_downloads=max(1, _int("MAX_CONCURRENT_DOWNLOADS", 3)),
        api_timeout=_int("API_TIMEOUT", 60),
        download_timeout=_int("DOWNLOAD_TIMEOUT", 900),
        log_level=(_env("LOG_LEVEL") or "INFO").upper(),
    )
