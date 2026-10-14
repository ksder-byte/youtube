#!/bin/sh
# Prepares .env after unpacking a new version. Never overwrites an existing one.
#
#   ./setup.sh           standalone bot (long polling)
#   ./setup.sh public    worker + Cobalt for the bot on Telegram Serverless
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
elif [ "$1" != "public" ]; then
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

[ "$1" = "public" ] || exit 0

# ── public setup: worker + Cobalt behind HTTPS for Telegram Serverless ───────
new_uuid() {
    if [ -r /proc/sys/kernel/random/uuid ]; then
        cat /proc/sys/kernel/random/uuid
    elif command -v uuidgen >/dev/null 2>&1; then
        uuidgen | tr 'A-Z' 'a-z'
    else
        python3 -c 'import uuid; print(uuid.uuid4())'
    fi
}

new_secret() {
    head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-48
}

echo
mkdir -p cobalt
if [ -f cobalt/keys.json ]; then
    echo "[ok] cobalt/keys.json is already here, leaving it alone."
    key=$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' cobalt/keys.json | head -n1)
else
    key=$(new_uuid)
    cat > cobalt/keys.json <<JSON
{
  "$key": {
    "name": "telegram-bot",
    "limit": "unlimited"
  }
}
JSON
    echo "[+] created cobalt/keys.json with a fresh Cobalt API key"
fi

missing=""
grep -qE '^COMPOSE_FILE=.*docker-compose\.public\.yml' .env || missing="$missing COMPOSE_FILE"
grep -qE '^PUBLIC_DOMAIN=.' .env || missing="$missing PUBLIC_DOMAIN"
grep -qE '^WORKER_SECRET=.{32,}' .env || missing="$missing WORKER_SECRET"
grep -qE "^COBALT_API_KEY=$key" .env || missing="$missing COBALT_API_KEY"

if [ -n "$missing" ]; then
    echo
    echo "[!] .env still needs:$missing"
    echo "    Add these lines (the secret below is freshly generated):"
    echo
    echo "COMPOSE_PATH_SEPARATOR=:"
    echo "COMPOSE_FILE=docker-compose.yml:docker-compose.public.yml"
    echo "PUBLIC_DOMAIN=dl.example.com"
    echo "WORKER_SECRET=$(new_secret)"
    echo "COBALT_API_KEY=$key"
fi

echo
echo "Then:"
echo "  docker compose build && docker compose up -d"
echo "  curl https://<PUBLIC_DOMAIN>/worker/healthz   # -> {\"ok\": true}"
echo
echo "And in serverless/tgcloud/lib/secrets.js:"
echo "  COBALT_INSTANCES: ['https://<PUBLIC_DOMAIN>|$key']"
echo "  WORKER_URL: 'https://<PUBLIC_DOMAIN>/worker'"
echo "  WORKER_SECRET: the same value as in .env"
