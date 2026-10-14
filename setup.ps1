# Prepares .env after unpacking a new version. Safe to run repeatedly:
# an existing .env is never touched, so your token survives updates.
#
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1

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
else {
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
