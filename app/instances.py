"""Health check for Cobalt instances.

Public instances (the kind listed on https://cobalt.directory) differ in
version, supported services and whether they want an API key. Run this before
putting one into COBALT_API_URL:

    python -m app.instances https://api.example.org https://other.example|key
    python -m app.instances --youtube https://api.example.org

`--youtube` additionally asks the instance to resolve one YouTube link, which
is the only way to tell a working session from a broken one. Use it sparingly:
somebody else pays for that traffic.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from urllib.parse import urlparse

from .cobalt import CobaltClient, CobaltError, CobaltUnavailable, Endpoint

# A stable, famously public video used only to see whether YouTube resolves.
PROBE_URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"

# What the auth errors actually mean for someone wiring up a bot.
AUTH_HINTS = {
    "error.api.auth.jwt.missing": (
        "инстанс закрыт капчей Turnstile — доступен только из браузера. "
        "Для бота нужен API-ключ от владельца или другой инстанс"
    ),
    "error.api.auth.jwt.invalid": "инстанс требует капчу Turnstile — боту недоступен",
    "error.api.auth.turnstile.missing": "инстанс требует капчу Turnstile — боту недоступен",
    "error.api.auth.key.missing": "нужен API-ключ: укажи адрес как «адрес|ключ»",
    "error.api.auth.key.invalid": "инстанс отклонил указанный API-ключ",
}


def parse_endpoints(items: list[str]) -> list[Endpoint]:
    endpoints: list[Endpoint] = []
    for item in items:
        for chunk in item.replace("\n", ",").split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            url, _, key = chunk.partition("|")
            endpoints.append(Endpoint(url=url.strip().rstrip("/"), api_key=key.strip() or None))
    return endpoints


def api_candidates(url: str) -> list[str]:
    """Where the API usually hides when the given address serves a frontend.

    Instances commonly split the two: the site on `cobalt.example.com`, the
    API on `api.example.com` or behind `/api`.
    """
    parsed = urlparse(url)
    host = parsed.netloc
    candidates = [f"{url}/api"]

    if not host.startswith("api."):
        labels = host.split(".")
        if len(labels) >= 3:
            # cobalt.example.com -> api.example.com
            candidates.append(f"{parsed.scheme}://api.{'.'.join(labels[1:])}")
        elif len(labels) == 2:
            candidates.append(f"{parsed.scheme}://api.{host}")

    return candidates


async def check(client: CobaltClient, endpoint: Endpoint, test_youtube: bool) -> str:
    probe = await client.probe(endpoint)

    if not probe.ok:
        lines = [f"❌ {endpoint.label:<40} {probe.error}"]
        if probe.snippet:
            lines.append(f"   ответ: {probe.snippet[:120]!r}")

        # Maybe we were handed the frontend address: try where the API usually is.
        for url in api_candidates(endpoint.url):
            candidate = Endpoint(url=url, api_key=endpoint.api_key)
            retry = await client.probe(candidate)
            if retry.ok:
                lines.append(
                    f"   ✅ зато отвечает {url} "
                    f"(v{retry.version}, {'youtube ✓' if retry.supports_youtube else 'youtube ✗'})"
                    " — используй этот адрес"
                )
                break
        else:
            lines.append(
                "   Поищи адрес API в директории — он часто отличается от адреса сайта."
            )
        return "\n".join(lines)

    line = (
        f"✅ {endpoint.label:<40} v{probe.version or '?':<12} "
        f"{len(probe.services):>3} площадок  {probe.latency_ms:>5} ms"
        f"  {'youtube ✓' if probe.supports_youtube else 'youtube ✗'}"
    )

    if not test_youtube:
        return line

    # A dedicated client so the probe never falls over to another instance.
    single = CobaltClient([endpoint], api_timeout=30)
    single.adopt_session(client.session)
    try:
        result = await single.process(PROBE_URL, video_quality="360")
        return f"{line}\n   → тест YouTube: {result.status} ✅"
    except CobaltError as exc:
        hint = AUTH_HINTS.get(exc.code)
        if hint:
            return f"{line}\n   → тест YouTube: {exc.code} ❌\n   {hint}"
        return f"{line}\n   → тест YouTube: {exc.code} ❌"
    except CobaltUnavailable as exc:
        return f"{line}\n   → тест YouTube не прошёл: {exc} ❌"


async def main_async(items: list[str], test_youtube: bool) -> int:
    endpoints = parse_endpoints(items)
    if not endpoints:
        print("Укажи хотя бы один адрес или задай COBALT_API_URL", file=sys.stderr)
        return 2

    client = CobaltClient(endpoints, api_timeout=15)
    await client.start()
    try:
        lines = await asyncio.gather(*(check(client, e, test_youtube) for e in endpoints))
    finally:
        await client.close()

    print("\n".join(lines))
    return 0 if any(line.startswith("✅") for line in lines) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("urls", nargs="*", help="адреса инстансов, можно в виде url|apikey")
    parser.add_argument(
        "--youtube",
        action="store_true",
        help="дополнительно попросить инстанс разобрать одну ссылку с YouTube",
    )
    args = parser.parse_args()

    items = args.urls or [os.environ.get("COBALT_API_URL", "")]
    return asyncio.run(main_async(items, args.youtube))


if __name__ == "__main__":
    raise SystemExit(main())
