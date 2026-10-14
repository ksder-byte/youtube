"""Entrypoint: wires the bot, the Cobalt client and long polling together."""

from __future__ import annotations

import asyncio
import logging
import sys

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramNetworkError, TelegramUnauthorizedError
from aiogram.types import BotCommand

from .cobalt import CobaltClient
from .config import Settings, load_settings
from .context import Context
from .handlers import router

log = logging.getLogger("bot")

COMMANDS = [
    BotCommand(command="start", description="Начать работу"),
    BotCommand(command="help", description="Как пользоваться"),
    BotCommand(command="status", description="Состояние Cobalt"),
]


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )
    logging.getLogger("aiogram.event").setLevel(logging.WARNING)


class StartupError(RuntimeError):
    """Something is misconfigured; the message says what to do about it."""


# Uploads may legitimately take TELEGRAM_TIMEOUT, but a getMe that does not
# answer in half a minute means something is wrong, not slow.
CONNECT_TIMEOUT = 30

# A refused connection means "not up yet" and is worth retrying. A hostname
# that does not resolve means the container is not running at all, which no
# amount of waiting will fix.
DNS_FAILURES = (
    "name or service not known",
    "temporary failure in name resolution",
    "nodename nor servname provided",
    "clientconnectordnserror",
)


def looks_like_a_missing_container(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in DNS_FAILURES)


async def connect(bot: Bot, settings: Settings, attempts: int = 10, delay: float = 3.0):
    """Reaches the Bot API, explaining the two ways this goes wrong."""
    target = settings.telegram_api_url or "api.telegram.org"
    log.info("Connecting to Bot API at %s...", target)

    for attempt in range(1, attempts + 1):
        try:
            return await bot.get_me(request_timeout=CONNECT_TIMEOUT)

        except TelegramUnauthorizedError as exc:
            if settings.telegram_api_url:
                raise StartupError(
                    f"The local Bot API server rejected the token ({exc})."
                    "\n  - check TELEGRAM_API_ID / TELEGRAM_API_HASH in .env"
                    "\n  - the bot must be logged out of the cloud API first:"
                    "\n      docker compose run --rm --no-deps bot python -m app.logout --yes"
                ) from exc
            raise StartupError(
                f"Telegram rejected the token ({exc})."
                "\n  - if you ran `python -m app.logout`, the bot now belongs to a local"
                "\n    Bot API server: set TELEGRAM_API_URL in .env and start with the"
                "\n    local-api profile, or wait ~10 minutes for the cloud API to take it back"
                "\n  - otherwise BOT_TOKEN is wrong"
            ) from exc

        except TelegramNetworkError as exc:
            missing = settings.telegram_api_url and looks_like_a_missing_container(str(exc))
            if missing or attempt == attempts:
                if missing:
                    raise StartupError(
                        f"There is no container named {target.split('//')[-1].split(':')[0]} "
                        "on this network - the Bot API server is not running."
                        "\n  - add COMPOSE_PROFILES=local-api to .env, or start with"
                        "\n      docker compose --profile local-api up -d"
                        "\n  - check it came up: docker compose ps telegram-bot-api"
                    ) from exc

                hint = (
                    "\n  - is the server running? `docker compose ps telegram-bot-api`"
                    "\n  - a plain `docker compose up` skips it unless .env has"
                    "\n    COMPOSE_PROFILES=local-api"
                    if settings.telegram_api_url
                    else "\n  - check the host's network and any proxy settings"
                )
                raise StartupError(
                    f"Cannot reach the Bot API at {target} after {attempts} tries ({exc}).{hint}"
                ) from exc
            log.warning(
                "Bot API at %s not reachable yet (%s/%s), retrying...", target, attempt, attempts
            )
            await asyncio.sleep(delay)

    raise AssertionError("unreachable")


async def run(settings: Settings) -> None:
    cobalt = CobaltClient(
        list(settings.cobalt_endpoints),
        api_key=settings.cobalt_api_key,
        api_timeout=settings.api_timeout,
        download_timeout=settings.download_timeout,
        max_download_bytes=settings.max_download_bytes,
    )
    await cobalt.start()

    session = None
    if settings.telegram_api_url:
        # A local Bot API server lifts the upload cap from 50 MB to 2000 MB.
        session = AiohttpSession(
            api=TelegramAPIServer.from_base(
                settings.telegram_api_url, is_local=settings.telegram_api_local
            ),
            timeout=settings.telegram_timeout,
        )
        log.info(
            "Using local Bot API server at %s (upload limit ~2000 MB)",
            settings.telegram_api_url,
        )

    bot = Bot(
        settings.bot_token,
        session=session,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dispatcher = Dispatcher()
    dispatcher["ctx"] = Context(settings=settings, cobalt=cobalt)
    dispatcher.include_router(router)

    try:
        # Cobalt boots slower than the bot: yt-session-generator has to warm up first.
        await cobalt.wait_until_ready()

        if settings.limit_exceeds_telegram:
            log.warning(
                "MAX_DOWNLOAD_MB=%s but this bot can upload at most %s MB — larger files "
                "will be rejected by Telegram. Raise the cap with a local Bot API server "
                "(TELEGRAM_API_URL) or lower MAX_DOWNLOAD_MB.",
                settings.max_download_mb,
                settings.upload_limit_mb,
            )

        me = await connect(bot, settings)
        log.info("Starting @%s (id=%s)", me.username, me.id)
        log.info(
            "Cobalt instances (in order): %s",
            ", ".join(e.label for e in settings.cobalt_endpoints),
        )
        if settings.subscription_required:
            log.info("Forced subscription is on: %s", settings.required_channel)
        else:
            log.info("Forced subscription is off (REQUIRED_CHANNEL is empty)")

        await bot.set_my_commands(COMMANDS)
        await bot.delete_webhook(drop_pending_updates=True)
        await dispatcher.start_polling(bot, handle_signals=True)
    finally:
        await cobalt.close()
        await bot.session.close()


def main() -> int:
    try:
        settings = load_settings()
    except RuntimeError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    setup_logging(settings.log_level)
    try:
        asyncio.run(run(settings))
    except StartupError as exc:
        log.error("Cannot start:\n%s", exc)
        return 3
    except (KeyboardInterrupt, SystemExit):
        log.info("Stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
