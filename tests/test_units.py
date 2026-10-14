"""Pure-function tests: no network, no Telegram."""

from pathlib import Path

import pytest

from app.cobalt import CobaltResult
from app.downloader import safe_filename
from app.keyboards import DownloadCallback, actions_kb, fallback_kb, quality_kb
from app.media import kind_of
from app.storage import Cooldown, LinkStore
from app.texts import cobalt_error


def test_safe_filename_strips_paths_and_exotic_chars():
    assert safe_filename("../../etc/passwd") == "passwd"
    assert safe_filename("a/b/c/video:name?.mp4") == "video_name_.mp4"
    assert safe_filename(None) == "download.bin"
    assert safe_filename("   ") == "download.bin"
    assert len(safe_filename("x" * 300 + ".mp4")) <= 121


def test_callback_roundtrip():
    packed = DownloadCallback("v", "1080", "aBc-dEf").pack()
    assert len(packed.encode()) <= 64
    assert DownloadCallback.unpack(packed) == DownloadCallback("v", "1080", "aBc-dEf")
    assert DownloadCallback.unpack("q:abc") is None


def test_every_button_fits_telegram_callback_limit():
    for markup in (actions_kb("tok1234", "1080"), quality_kb("tok1234"), fallback_kb("tok1234", "1080")):
        for row in markup.inline_keyboard:
            for button in row:
                if button.callback_data:
                    assert len(button.callback_data.encode()) <= 64


def test_fallback_offers_only_lower_qualities():
    labels = [
        b.text for row in fallback_kb("t", "480").inline_keyboard for b in row
    ]
    assert "🎬 720p" not in labels
    assert "🎬 360p" in labels


def test_parse_tunnel_response():
    result = CobaltResult.parse({"status": "tunnel", "url": "http://c/t", "filename": "a.mp4"})
    assert result.url == "http://c/t"
    assert result.filename == "a.mp4"


def test_parse_picker_response():
    result = CobaltResult.parse(
        {
            "status": "picker",
            "audio": "http://c/audio",
            "audioFilename": "sound.mp3",
            "picker": [
                {"type": "photo", "url": "http://c/1"},
                {"type": "video", "url": "http://c/2"},
                {"type": "photo"},  # no url -> dropped
            ],
        }
    )
    assert [item.type for item in result.picker] == ["photo", "video"]
    assert result.audio_filename == "sound.mp3"


def test_parse_local_processing_response():
    result = CobaltResult.parse(
        {
            "status": "local-processing",
            "type": "merge",
            "tunnel": ["http://c/v", "http://c/a"],
            "output": {"type": "video/mp4", "filename": "clip.mp4"},
        }
    )
    assert result.tunnels == ["http://c/v", "http://c/a"]
    assert result.output_filename == "clip.mp4"


def test_link_store_ttl():
    store = LinkStore(ttl=0)
    token = store.put("https://youtu.be/x")
    assert store.get(token) is None

    store = LinkStore(ttl=60)
    token = store.put("https://youtu.be/x")
    assert store.get(token) == "https://youtu.be/x"
    assert store.get("nope") is None


def test_cooldown_blocks_second_job():
    cooldown = Cooldown()
    assert cooldown.acquire(1) is True
    assert cooldown.acquire(1) is False
    cooldown.release(1)
    assert cooldown.acquire(1) is True


@pytest.mark.parametrize(
    ("name", "expected"),
    [("a.mp4", "video"), ("a.mp3", "audio"), ("a.jpg", "photo"), ("a.gif", "animation"), ("a.bin", "document")],
)
def test_kind_of(name, expected):
    assert kind_of(Path(name)) == expected


def test_known_error_codes_are_translated():
    assert "YouTube" in cobalt_error("error.api.youtube.login")
    assert "error.api.made.up" in cobalt_error("error.api.made.up")


def test_instance_list_parsing():
    from app.instances import parse_endpoints

    endpoints = parse_endpoints(["https://a.example, https://b.example|key", "https://c.example/"])
    assert [e.url for e in endpoints] == [
        "https://a.example",
        "https://b.example",
        "https://c.example",
    ]
    assert [e.api_key for e in endpoints] == [None, "key", None]


def test_env_survives_a_powershell_bom(monkeypatch):
    """PowerShell writes .env as UTF-8 with BOM, which sticks to the first name."""
    from app.config import load_settings

    monkeypatch.delenv("BOT_TOKEN", raising=False)
    monkeypatch.setenv("﻿BOT_TOKEN", "123:abc")
    monkeypatch.setenv("COBALT_API_URL", "http://cobalt:9000")
    assert load_settings().bot_token == "123:abc"


def test_api_candidates_for_a_frontend_address():
    from app.instances import api_candidates

    assert api_candidates("https://cobalt.kittycat.boo") == [
        "https://cobalt.kittycat.boo/api",
        "https://api.kittycat.boo",
    ]
    assert api_candidates("https://kittycat.boo") == [
        "https://kittycat.boo/api",
        "https://api.kittycat.boo",
    ]
    # Already an api host: no point guessing another one.
    assert api_candidates("https://api.example.org") == ["https://api.example.org/api"]


def test_auth_errors_are_explained_not_just_echoed():
    from app.instances import AUTH_HINTS
    from app.texts import cobalt_error

    # The bot user and the operator running the CLI both get a real sentence.
    assert "Turnstile" in cobalt_error("error.api.auth.jwt.missing")
    assert "Turnstile" in AUTH_HINTS["error.api.auth.jwt.missing"]
    assert "ключ" in cobalt_error("error.api.auth.key.missing")


# --------------------------------------------------------------------------- #
# upload limits: what Telegram accepts vs. what we were told to download
# --------------------------------------------------------------------------- #

def make_settings(**overrides):
    from app.config import Settings

    base = dict(
        bot_token="1:t", cobalt_api_url="http://cobalt:9000", cobalt_api_key=None,
        cobalt_endpoints=(), required_channel=None, required_channel_url=None,
        max_download_mb=50, video_quality="1080", audio_format="mp3", audio_bitrate="128",
        youtube_video_codec="h264", youtube_better_audio=False,
        max_concurrent_downloads=3, api_timeout=60, download_timeout=900, log_level="INFO",
        always_proxy=True, ytdlp_for_youtube=True, ytdlp_fallback_to_cobalt=False,
        ytdlp_cookies_file=None, telegram_api_url=None, telegram_api_local=True,
        telegram_timeout=900,
    )
    base.update(overrides)
    known = {f for f in Settings.__dataclass_fields__}
    return Settings(**{k: v for k, v in base.items() if k in known})


def test_cloud_api_caps_uploads_at_50mb():
    settings = make_settings(max_download_mb=50)
    assert settings.upload_limit_mb == 50
    assert settings.limit_exceeds_telegram is False


def test_raising_the_cap_without_a_local_server_is_flagged():
    settings = make_settings(max_download_mb=500)
    assert settings.upload_limit_mb == 50
    assert settings.limit_exceeds_telegram is True


def test_local_server_raises_the_ceiling():
    settings = make_settings(max_download_mb=2000, telegram_api_url="http://telegram-bot-api:8081")
    assert settings.upload_limit_mb == 2000
    assert settings.limit_exceeds_telegram is False


def test_too_large_message_mentions_the_local_server_only_when_it_would_help():
    from app.texts import too_large

    assert "локальный Bot API" in too_large(120.0, 50)
    assert "локальный Bot API" not in too_large(2500.0, 2000)


# --------------------------------------------------------------------------- #
# startup diagnostics
# --------------------------------------------------------------------------- #

async def test_unauthorized_explains_the_logout_state():
    """After `app.logout` the cloud API rejects the token — say why, not raise 401."""
    from aiogram.exceptions import TelegramUnauthorizedError

    from app.__main__ import StartupError, connect

    class DeadBot:
        async def get_me(self, request_timeout=None):
            raise TelegramUnauthorizedError(method=None, message="Unauthorized")

    cloud = make_settings(telegram_api_url=None)
    with pytest.raises(StartupError) as excinfo:
        await connect(DeadBot(), cloud, attempts=1, delay=0)
    assert "app.logout" in str(excinfo.value)

    local = make_settings(telegram_api_url="http://telegram-bot-api:8081")
    with pytest.raises(StartupError) as excinfo:
        await connect(DeadBot(), local, attempts=1, delay=0)
    assert "TELEGRAM_API_ID" in str(excinfo.value)


async def test_unreachable_api_is_retried_then_explained():
    from aiogram.exceptions import TelegramNetworkError

    from app.__main__ import StartupError, connect

    tries = []

    class OfflineBot:
        async def get_me(self, request_timeout=None):
            tries.append(1)
            raise TelegramNetworkError(method=None, message="Cannot connect")

    settings = make_settings(telegram_api_url="http://telegram-bot-api:8081")
    with pytest.raises(StartupError) as excinfo:
        await connect(OfflineBot(), settings, attempts=3, delay=0)

    assert len(tries) == 3
    assert "COMPOSE_PROFILES=local-api" in str(excinfo.value)


async def test_connect_returns_once_the_api_answers():
    from aiogram.exceptions import TelegramNetworkError

    from app.__main__ import connect

    class SlowBot:
        def __init__(self) -> None:
            self.calls = 0

        async def get_me(self, request_timeout=None):
            self.calls += 1
            if self.calls < 2:
                raise TelegramNetworkError(method=None, message="not yet")
            return "me"

    assert await connect(SlowBot(), make_settings(), attempts=5, delay=0) == "me"


def test_setup_scripts_stay_ascii():
    """Windows PowerShell reads .ps1 as ANSI: one UTF-8 byte breaks the parser."""
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    for name in ("setup.ps1", "setup.sh"):
        raw = (root / name).read_bytes()
        offenders = [(i, b) for i, b in enumerate(raw) if b > 127]
        assert not offenders, f"{name} has non-ASCII bytes at {offenders[:3]}"


async def test_connect_probe_does_not_inherit_the_upload_timeout():
    """A 900s upload timeout must not make a dead API look like a 15-minute hang."""
    from app.__main__ import CONNECT_TIMEOUT, connect

    seen: list[int | None] = []

    class RecordingBot:
        async def get_me(self, request_timeout=None):
            seen.append(request_timeout)
            return "me"

    await connect(RecordingBot(), make_settings(telegram_timeout=900), attempts=1, delay=0)
    assert seen == [CONNECT_TIMEOUT]
    assert CONNECT_TIMEOUT <= 60


async def test_missing_container_fails_immediately_with_the_profile_hint():
    """A hostname that does not resolve will not start resolving in 50 seconds."""
    from aiogram.exceptions import TelegramNetworkError

    from app.__main__ import StartupError, connect

    tries = []

    class NoContainerBot:
        async def get_me(self, request_timeout=None):
            tries.append(1)
            raise TelegramNetworkError(
                method=None,
                message="ClientConnectorDNSError: Cannot connect to host "
                "telegram-bot-api:8081 ssl:default [Name or service not known]",
            )

    settings = make_settings(telegram_api_url="http://telegram-bot-api:8081")
    with pytest.raises(StartupError) as excinfo:
        await connect(NoContainerBot(), settings, attempts=10, delay=0)

    assert len(tries) == 1, "must not retry a name that does not resolve"
    message = str(excinfo.value)
    assert "COMPOSE_PROFILES=local-api" in message
    assert "telegram-bot-api" in message


async def test_refused_connection_is_still_retried():
    """The server may simply not be listening yet — that is worth waiting for."""
    from aiogram.exceptions import TelegramNetworkError

    from app.__main__ import connect

    class SlowServerBot:
        def __init__(self) -> None:
            self.calls = 0

        async def get_me(self, request_timeout=None):
            self.calls += 1
            if self.calls < 3:
                raise TelegramNetworkError(method=None, message="Connection refused")
            return "me"

    settings = make_settings(telegram_api_url="http://telegram-bot-api:8081")
    assert await connect(SlowServerBot(), settings, attempts=5, delay=0) == "me"


def test_dns_detection_ignores_ordinary_failures():
    from app.__main__ import looks_like_a_missing_container

    assert looks_like_a_missing_container("Cannot connect [Name or service not known]")
    assert looks_like_a_missing_container("ClientConnectorDNSError: ...")
    assert not looks_like_a_missing_container("Connection refused")
    assert not looks_like_a_missing_container("Request timeout error")
