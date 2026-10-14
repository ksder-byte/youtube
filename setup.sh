#!/bin/sh
# Prepares .env after unpacking a new version. Never overwrites an existing one.
set -e
cd "$(dirname "$0")"

if [ -f .env ]; then
    echo "[ok] .env is already here, leaving it alone."
else
    cp .env.example .env
    echo "[+] created .env from .env.example - put your BOT_TOKEN in it"
fi

token_line=$(grep -m1 '^BOT_TOKEN=' .env || true)
if [ -z "$token_line" ] || echo "$token_line" | grep -qE '^BOT_TOKEN=[[:space:]]*$|replace_me'; then
    echo "[!] BOT_TOKEN is still empty or a placeholder - the bot will refuse to start."
    echo "    Edit .env, then run: docker compose build && docker compose up -d"
else
    echo
    echo "Next:"
    echo "  docker compose build"
    echo "  docker compose up -d"
    echo "  docker compose logs -f bot"
fi

# A local Bot API server only starts when its compose profile is active.
if grep -qE '^TELEGRAM_API_URL=.' .env && ! grep -qE '^COMPOSE_PROFILES=.*local-api' .env; then
    echo "[!] TELEGRAM_API_URL is set but COMPOSE_PROFILES is not."
    echo "    docker compose up will skip the Bot API server and the bot will not start."
    echo "    Add this line to .env:  COMPOSE_PROFILES=local-api"
fi
