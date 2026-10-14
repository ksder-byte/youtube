"""Blocks until yt-session-generator has minted its first PO token.

Cobalt asks the session server for a token exactly once, at startup. If the
generator is not listening yet — it boots Xvfb, launches Chromium and updates
its extractor first, which easily takes a minute — Cobalt logs

    [!] Failed loading poToken & visitor_data ... ECONNREFUSED

and then serves every YouTube request with error.api.youtube.no_session_tokens
until it is restarted. `depends_on` alone does not help: it waits for the
container to start, not for the token to exist.

So this runs as a one-shot service between the two: Cobalt only starts once
this exits.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time

import aiohttp

from .cobalt import fetch_session_token

SERVER_URL = os.environ.get("YT_SESSION_SERVER_URL", "http://yt-session-generator:8080")
TIMEOUT_SECONDS = int(os.environ.get("YT_SESSION_WAIT_SECONDS", "180"))
POLL_SECONDS = float(os.environ.get("YT_SESSION_POLL_SECONDS", "5"))


async def wait(
    server_url: str | None = None,
    timeout: float | None = None,
    poll: float | None = None,
) -> bool:
    server_url = server_url or SERVER_URL
    timeout = TIMEOUT_SECONDS if timeout is None else timeout
    poll = POLL_SECONDS if poll is None else poll

    deadline = time.monotonic() + timeout
    print(
        f"[..] waiting up to {int(timeout)}s for {server_url} to mint a YouTube PO token "
        "(it boots Chromium first, so a minute is normal)",
        flush=True,
    )

    async with aiohttp.ClientSession() as session:
        while time.monotonic() < deadline:
            token = await fetch_session_token(session, server_url)
            if token:
                waited = int(timeout - (deadline - time.monotonic()))
                print(f"[ok] token is ready after {waited}s — starting Cobalt", flush=True)
                return True
            # Print every poll: a silent container is indistinguishable from a hung one.
            print(f"[..] not ready yet, {int(deadline - time.monotonic())}s left", flush=True)
            await asyncio.sleep(poll)

    return False


def main() -> int:
    if asyncio.run(wait()):
        return 0

    # Starting Cobalt without a token is still better than blocking the whole
    # stack: the bot retries YouTube requests while the session warms up.
    print(
        f"[!!] no PO token after {TIMEOUT_SECONDS}s. Cobalt will start anyway, but YouTube "
        "will fail until you run: docker compose restart cobalt",
        file=sys.stderr,
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
