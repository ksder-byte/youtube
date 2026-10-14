"""Moves the bot between the cloud Bot API and a local one.

Telegram only lets a bot talk to one Bot API server at a time. To hand it to a
local server you must log it out of the cloud one first; to hand it back you
close the local server's session. Both are one-time, deliberate actions, so
they require an explicit --yes.

    python -m app.logout --yes          # cloud  -> local  (call before switching)
    python -m app.logout --close --yes  # local  -> cloud  (call before switching back)
"""

from __future__ import annotations

import argparse
import asyncio
import sys

import aiohttp

from .config import load_settings

CLOUD_API = "https://api.telegram.org"


async def call(base_url: str, token: str, method: str) -> tuple[bool, str]:
    url = f"{base_url.rstrip('/')}/bot{token}/{method}"
    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url) as resp:
            data = await resp.json(content_type=None)

    if data.get("ok"):
        return True, "ok"
    return False, str(data.get("description") or data)


async def run(close: bool, settings) -> int:
    if close:
        if not settings.telegram_api_url:
            print(
                "TELEGRAM_API_URL is not set — there is no local server to close.",
                file=sys.stderr,
            )
            return 2
        target, method, after = settings.telegram_api_url, "close", (
            "Local server released the bot. Remove TELEGRAM_API_URL from .env, "
            "lower MAX_DOWNLOAD_MB back to 50 and restart."
        )
    else:
        target, method, after = CLOUD_API, "logOut", (
            "Bot is logged out of the cloud API. Set TELEGRAM_API_URL in .env, "
            "raise MAX_DOWNLOAD_MB (up to 2000) and start with "
            "`docker compose --profile local-api up -d`."
        )

    ok, detail = await call(target, settings.bot_token, method)
    if ok:
        print(f"[ok] {method} succeeded.\n     {after}")
        return 0

    print(f"[!!] {method} failed: {detail}", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--close",
        action="store_true",
        help="release the bot from the local server instead of the cloud one",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="required: confirms this one-time, account-wide switch",
    )
    args = parser.parse_args()

    try:
        settings = load_settings()
    except RuntimeError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    if not args.yes:
        action = "close the local server's session" if args.close else "log out of the cloud API"
        print(
            f"This will {action} for your bot — it stops serving until you point it at the\n"
            "other server. Re-run with --yes if that is what you want.",
            file=sys.stderr,
        )
        return 2

    return asyncio.run(run(args.close, settings))


if __name__ == "__main__":
    raise SystemExit(main())
