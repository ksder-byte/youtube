# Prepares .env after unpacking a new version. Safe to run repeatedly:
# an existing .env is never touched, so your token survives updates.
#
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1           standalone bot
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1 public    worker for Telegram Serverless

param([string]$Mode = "")

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (Test-Path ".env") {
    Write-Host "[ok] .env is already here, leaving it alone." -ForegroundColor Green
}
else {
    Copy-Item ".env.example" ".env"
    Write-Host "[+] created .env from .env.example" -ForegroundColor Yellow
    Write-Host "    Put your @BotFather token into BOT_TOKEN, then run: docker compose up -d"
    notepad ".env"
}

$tokenLine = (Select-String -Path ".env" -Pattern "^BOT_TOKEN=" | Select-Object -First 1).Line
if (-not $tokenLine -or $tokenLine -match "^BOT_TOKEN=\s*$" -or $tokenLine -match "replace_me") {
    Write-Host "[!] BOT_TOKEN is still empty or a placeholder - the bot will refuse to start." -ForegroundColor Red
    Write-Host "    Edit .env, then run:  docker compose build ; docker compose up -d"
}
elseif ($Mode -ne "public") {
    Write-Host ""
    Write-Host "Next:" -ForegroundColor Cyan
    Write-Host "  docker compose build"
    Write-Host "  docker compose up -d"
    Write-Host "  docker compose logs -f bot"
}

# A local Bot API server only starts when its compose profile is active.
$hasApi = Select-String -Path ".env" -Pattern "^TELEGRAM_API_URL=." -Quiet
$hasProfile = Select-String -Path ".env" -Pattern "^COMPOSE_PROFILES=.*local-api" -Quiet
if ($hasApi -and -not $hasProfile) {
    Write-Host "[!] TELEGRAM_API_URL is set but COMPOSE_PROFILES is not." -ForegroundColor Red
    Write-Host "    `docker compose up` will skip the Bot API server and the bot will not start."
    Write-Host "    Add this line to .env:  COMPOSE_PROFILES=local-api"
}

if ($Mode -ne "public") { exit 0 }

# -- public setup: worker + Cobalt behind HTTPS for Telegram Serverless --------
Write-Host ""
New-Item -ItemType Directory -Force -Path "cobalt" | Out-Null
if (Test-Path "cobalt/keys.json") {
    Write-Host "[ok] cobalt/keys.json is already here, leaving it alone." -ForegroundColor Green
    $key = ([regex]::Match((Get-Content "cobalt/keys.json" -Raw), "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")).Value
}
else {
    $key = [guid]::NewGuid().ToString()
    $json = "{`n  `"$key`": {`n    `"name`": `"telegram-bot`",`n    `"limit`": `"unlimited`"`n  }`n}`n"
    # UTF-8 without BOM: Cobalt's JSON parser does not expect one.
    [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "cobalt/keys.json"), $json, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "[+] created cobalt/keys.json with a fresh Cobalt API key" -ForegroundColor Yellow
}

$bytes = New-Object byte[] 36
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$secret = ([Convert]::ToBase64String($bytes)) -replace "[/+=]", ""

Write-Host ""
Write-Host "Make sure .env has these lines (the secret is freshly generated):" -ForegroundColor Cyan
Write-Host "COMPOSE_PATH_SEPARATOR=:"
Write-Host "COMPOSE_FILE=docker-compose.yml:docker-compose.public.yml"
Write-Host "PUBLIC_DOMAIN=dl.example.com"
Write-Host "WORKER_SECRET=$secret"
Write-Host "COBALT_API_KEY=$key"
Write-Host ""
Write-Host "And in serverless/tgcloud/lib/secrets.js:" -ForegroundColor Cyan
Write-Host "  COBALT_INSTANCES: ['https://<PUBLIC_DOMAIN>|$key']"
Write-Host "  WORKER_URL: 'https://<PUBLIC_DOMAIN>/worker'"
Write-Host "  WORKER_SECRET: the same value as in .env"
