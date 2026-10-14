"""Async client for the Cobalt API (schema version 11) with instance failover."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import aiohttp

log = logging.getLogger(__name__)

# Cobalt answers with these top-level statuses.
STATUS_ERROR = "error"
STATUS_PICKER = "picker"
STATUS_REDIRECT = "redirect"
STATUS_TUNNEL = "tunnel"
STATUS_LOCAL_PROCESSING = "local-processing"

# Errors that say "this instance cannot do it" rather than "this link is bad".
# Only these are worth retrying somewhere else; a private video stays private
# on every instance in the world.
FAILOVER_ERROR_CODES = frozenset(
    {
        "error.api.youtube.no_session_tokens",
        "error.api.youtube.token_expired",
        "error.api.youtube.login",
        "error.api.youtube.decipher",
        "error.api.youtube.no_hls_streams",
        "error.api.youtube.codec",
        "error.api.fetch.fail",
        "error.api.fetch.critical",
        "error.api.fetch.rate",
        "error.api.service.disabled",
        "error.api.service.unsupported",
        "error.api.capacity",
        "error.api.rate_exceeded",
        "error.api.generic",
        "error.api.unknown",
    }
)

# How long an instance is skipped after it refused to talk to us at all.
UNHEALTHY_COOLDOWN = 300.0


def should_failover(code: str) -> bool:
    # error.api.auth.* means our key is wrong *for that instance*.
    return code in FAILOVER_ERROR_CODES or code.startswith("error.api.auth.")


class CobaltError(RuntimeError):
    """Cobalt answered with `status: error`."""

    def __init__(self, code: str, context: dict[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.context = context or {}


class CobaltUnavailable(RuntimeError):
    """No configured instance could be reached."""


@dataclass(slots=True)
class Endpoint:
    url: str
    api_key: str | None = None
    unhealthy_until: float = 0.0

    @property
    def label(self) -> str:
        return urlparse(self.url).netloc or self.url

    @property
    def healthy(self) -> bool:
        return self.unhealthy_until <= time.monotonic()

    def mark_unhealthy(self, seconds: float = UNHEALTHY_COOLDOWN) -> None:
        self.unhealthy_until = time.monotonic() + seconds

    def mark_healthy(self) -> None:
        self.unhealthy_until = 0.0


@dataclass(slots=True)
class Probe:
    """What one instance answered when asked who it is."""

    endpoint: Endpoint
    http_status: int | None = None
    content_type: str | None = None
    latency_ms: int | None = None
    version: str | None = None
    services: list[str] = field(default_factory=list)
    info: dict[str, Any] | None = None
    snippet: str | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None and self.version is not None

    @property
    def supports_youtube(self) -> bool:
        return "youtube" in self.services


def _describe_non_json(status: int, snippet: str) -> str:
    """Turns an HTML answer into a sentence that says what to do about it."""
    lowered = snippet.lower()
    if "just a moment" in lowered or "cloudflare" in lowered or "cf-browser" in lowered:
        return "Cloudflare показывает проверку браузера — API так недоступен"
    if status in {401, 403}:
        return f"HTTP {status}: инстанс требует ключ или закрыт для чужих"
    if "<!doctype html" in lowered or "<html" in lowered:
        return "отдаёт HTML вместо JSON — похоже, это адрес веб-морды, а не API"
    return f"HTTP {status}: ответ не является JSON"


@dataclass(slots=True)
class PickerItem:
    type: str
    url: str
    thumb: str | None = None


@dataclass(slots=True)
class CobaltResult:
    status: str
    url: str | None = None
    filename: str | None = None
    picker: list[PickerItem] = field(default_factory=list)
    audio_url: str | None = None
    audio_filename: str | None = None
    # `local-processing` hands us the raw tracks and expects the client to mux them.
    tunnels: list[str] = field(default_factory=list)
    output_filename: str | None = None
    output_type: str | None = None
    # Which instance produced this answer; tunnel URLs point back at it.
    source: str | None = None

    @classmethod
    def parse(cls, data: dict[str, Any], source: str | None = None) -> "CobaltResult":
        status = data.get("status", "")
        if status == STATUS_PICKER:
            items = [
                PickerItem(
                    type=item.get("type", "photo"),
                    url=item["url"],
                    thumb=item.get("thumb"),
                )
                for item in data.get("picker", [])
                if item.get("url")
            ]
            return cls(
                status=status,
                picker=items,
                audio_url=data.get("audio"),
                audio_filename=data.get("audioFilename"),
                source=source,
            )

        if status == STATUS_LOCAL_PROCESSING:
            output = data.get("output") or {}
            return cls(
                status=status,
                tunnels=[t for t in data.get("tunnel", []) if t],
                output_filename=output.get("filename"),
                output_type=output.get("type"),
                source=source,
            )

        return cls(
            status=status,
            url=data.get("url"),
            filename=data.get("filename"),
            source=source,
        )


class CobaltClient:
    """Talks to one or more Cobalt instances, falling back in order."""

    def __init__(
        self,
        endpoints: list[Endpoint] | list[str],
        *,
        api_key: str | None = None,
        api_timeout: int = 60,
        download_timeout: int = 900,
        max_download_bytes: int | None = None,
    ) -> None:
        self.endpoints: list[Endpoint] = [
            item if isinstance(item, Endpoint) else Endpoint(item.rstrip("/"), api_key)
            for item in endpoints
        ]
        if not self.endpoints:
            raise ValueError("at least one Cobalt endpoint is required")
        self._api_timeout = aiohttp.ClientTimeout(total=api_timeout)
        # `sock_read` guards against a stalled tunnel without killing long downloads.
        self._download_timeout = aiohttp.ClientTimeout(total=download_timeout, sock_read=120)
        self.max_download_bytes = max_download_bytes
        self._session: aiohttp.ClientSession | None = None

    # ---------------------------------------------------------------- session

    async def start(self) -> None:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=self._download_timeout,
                headers={"User-Agent": "cobalt-telegram-bot/1.0"},
            )

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None

    def adopt_session(self, session: aiohttp.ClientSession) -> None:
        """Borrow someone else's session; the owner stays responsible for closing it."""
        self._session = session

    @property
    def session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            raise RuntimeError("CobaltClient.start() must be awaited before use")
        return self._session

    @property
    def primary(self) -> Endpoint:
        return self.endpoints[0]

    def _headers(self, endpoint: Endpoint) -> dict[str, str]:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if endpoint.api_key:
            headers["Authorization"] = f"Api-Key {endpoint.api_key}"
        return headers

    def _ordered(self) -> list[Endpoint]:
        """Healthy instances first, but never drop one entirely: a cooled-down
        instance is still better than telling the user we gave up."""
        healthy = [e for e in self.endpoints if e.healthy]
        cooling = [e for e in self.endpoints if not e.healthy]
        return healthy + cooling

    # ------------------------------------------------------------ diagnostics

    async def server_info(self, endpoint: Endpoint | None = None) -> dict[str, Any]:
        """`GET /` returns instance metadata; handy as a readiness probe."""
        endpoint = endpoint or self.primary
        async with self.session.get(
            f"{endpoint.url}/", headers=self._headers(endpoint), timeout=self._api_timeout
        ) as resp:
            body = await resp.read()
            try:
                data = json.loads(body)
            except ValueError as exc:
                raise CobaltUnavailable(
                    f"{endpoint.label} answered HTTP {resp.status} with "
                    f"{resp.headers.get('Content-Type', 'no content-type')}, not JSON"
                ) from exc
            if not isinstance(data, dict):
                raise CobaltUnavailable(f"{endpoint.label} returned {data!r}")
            return data

    async def probe(self, endpoint: Endpoint) -> Probe:
        """Full diagnostic of one instance: never raises, explains what arrived."""
        started = time.monotonic()
        try:
            async with self.session.get(
                f"{endpoint.url}/", headers=self._headers(endpoint), timeout=self._api_timeout
            ) as resp:
                body = await resp.read()
                common = {
                    "endpoint": endpoint,
                    "http_status": resp.status,
                    "content_type": resp.headers.get("Content-Type"),
                    "latency_ms": int((time.monotonic() - started) * 1000),
                }
                snippet = body[:200].decode("utf-8", errors="replace").strip()

                try:
                    data = json.loads(body)
                except ValueError:
                    return Probe(
                        **common,
                        snippet=snippet,
                        error=_describe_non_json(resp.status, snippet),
                    )

                if not isinstance(data, dict) or not isinstance(data.get("cobalt"), dict):
                    return Probe(
                        **common,
                        snippet=snippet,
                        error="это JSON, но не ответ Cobalt API",
                    )

                info = data["cobalt"]
                return Probe(
                    **common,
                    version=info.get("version"),
                    services=list(info.get("services") or []),
                    info=data,
                )
        except Exception as exc:  # noqa: BLE001 - diagnostics must not raise
            return Probe(endpoint=endpoint, error=f"{type(exc).__name__}: {exc}")

    async def survey(self) -> list[Probe]:
        """Probes every configured instance; used by /status."""
        return list(await asyncio.gather(*(self.probe(e) for e in self.endpoints)))

    async def wait_until_ready(self, attempts: int = 30, delay: float = 2.0) -> bool:
        """Waits for the first instance to answer. Extra instances are optional,
        so one live endpoint is enough to start serving."""
        for attempt in range(1, attempts + 1):
            for probe in await self.survey():
                if probe.ok:
                    log.info(
                        "Cobalt ready at %s (version %s)", probe.endpoint.label, probe.version
                    )
                    return True
                log.info("%s: %s", probe.endpoint.label, probe.error)
            log.info("Waiting for a Cobalt instance (%s/%s)", attempt, attempts)
            await asyncio.sleep(delay)

        log.error(
            "None of the configured instances answered: %s",
            ", ".join(e.label for e in self.endpoints),
        )
        return False

    # ---------------------------------------------------------------- process

    async def _post(
        self, endpoint: Endpoint, payload: dict[str, Any]
    ) -> tuple[dict[str, Any], int]:
        async with self.session.post(
            f"{endpoint.url}/",
            json=payload,
            headers=self._headers(endpoint),
            timeout=self._api_timeout,
        ) as resp:
            try:
                data = await resp.json(content_type=None)
            except Exception as exc:  # noqa: BLE001
                body = await resp.text()
                raise CobaltUnavailable(
                    f"{endpoint.label} returned non-JSON (HTTP {resp.status}): {body[:200]}"
                ) from exc
            if not isinstance(data, dict):
                raise CobaltUnavailable(f"{endpoint.label} returned {data!r}")
            return data, resp.status

    async def process(
        self,
        url: str,
        *,
        download_mode: str = "auto",
        video_quality: str = "1080",
        audio_format: str = "mp3",
        audio_bitrate: str = "128",
        youtube_video_codec: str = "h264",
        youtube_better_audio: bool = False,
        local_processing: str = "disabled",
        always_proxy: bool = True,
    ) -> CobaltResult:
        payload = {
            "url": url,
            "downloadMode": download_mode,
            "videoQuality": video_quality,
            "audioFormat": audio_format,
            "audioBitrate": audio_bitrate,
            "filenameStyle": "basic",
            "youtubeVideoCodec": youtube_video_codec,
            "youtubeVideoContainer": "mp4",
            # Opt-in: the better-audio track is often opus, which cannot be
            # copied into mp4, so the instance has to transcode it. When that
            # transcode fails the tunnel silently returns zero bytes.
            "youtubeBetterAudio": youtube_better_audio,
            "disableMetadata": False,
            # "disabled" makes the instance mux server-side. On "preferred" it
            # hands us the raw tracks and we mux them locally with ffmpeg.
            "localProcessing": local_processing,
            # Proxying everything through the instance is the reliable choice
            # for YouTube, but it makes the instance pay for the whole file.
            # On someone else's server that is worth thinking about.
            "alwaysProxy": always_proxy,
        }

        endpoints = self._ordered()
        # With a single instance there is nowhere to fail over to, so retry it.
        attempts_each = 2 if len(endpoints) == 1 else 1
        last_code: str | None = None
        last_context: dict[str, Any] | None = None
        transport_errors: list[str] = []

        for endpoint in endpoints:
            for attempt in range(1, attempts_each + 1):
                try:
                    data, http_status = await self._post(endpoint, payload)
                except (aiohttp.ClientError, asyncio.TimeoutError, CobaltUnavailable) as exc:
                    transport_errors.append(f"{endpoint.label}: {exc}")
                    log.warning("%s did not answer (%s/%s): %s", endpoint.label, attempt, attempts_each, exc)
                    endpoint.mark_unhealthy()
                    if attempt < attempts_each:
                        await asyncio.sleep(2**attempt)
                    continue

                if http_status == 429 or http_status >= 500:
                    transport_errors.append(f"{endpoint.label}: HTTP {http_status}")
                    log.warning("%s answered HTTP %s, moving on", endpoint.label, http_status)
                    endpoint.mark_unhealthy()
                    break

                if data.get("status") == STATUS_ERROR:
                    error = data.get("error") or {}
                    code = error.get("code", "error.api.unknown")
                    if not should_failover(code):
                        # The link itself is the problem: no other instance helps.
                        raise CobaltError(code, error.get("context"))
                    last_code, last_context = code, error.get("context")
                    log.info("%s refused with %s, trying the next instance", endpoint.label, code)
                    if code.startswith("error.api.auth.") or code in {
                        "error.api.capacity",
                        "error.api.rate_exceeded",
                    }:
                        endpoint.mark_unhealthy()
                    break

                if not data.get("status"):
                    transport_errors.append(f"{endpoint.label}: response without status")
                    endpoint.mark_unhealthy()
                    break

                endpoint.mark_healthy()
                if endpoint is not self.primary:
                    log.info("Served %s via fallback instance %s", url, endpoint.label)
                return CobaltResult.parse(data, source=endpoint.label)

        if last_code is not None:
            # Every instance refused for the same kind of reason: report it.
            raise CobaltError(last_code, last_context)
        raise CobaltUnavailable("; ".join(transport_errors) or "no instance answered")
