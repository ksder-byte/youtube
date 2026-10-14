"""User-facing strings and Cobalt error-code translations."""

from __future__ import annotations

START = (
    "👋 <b>Привет!</b>\n\n"
    "Пришли ссылку — я скачаю видео или звук и отправлю файлом прямо сюда.\n\n"
    "🎬 YouTube (включая Shorts) — основной сценарий\n"
    "📦 Также работают TikTok, Instagram, X/Twitter, VK, Reddit, Twitch-клипы, "
    "SoundCloud и другие площадки, которые поддерживает твой инстанс Cobalt.\n\n"
    "Команды: /help — справка, /status — состояние Cobalt."
)

HELP = (
    "<b>Как пользоваться</b>\n\n"
    "1. Пришли ссылку на публичный пост или видео.\n"
    "2. Выбери, что скачать: видео или только звук.\n"
    "3. Дождись файла.\n\n"
    "<b>Полезно знать</b>\n"
    "• Качество можно выбрать кнопкой «⚙️ Качество».\n"
    "• Если файл больше лимита Telegram, я предложу качество пониже или аудио.\n"
    "• Приватные, платные и защищённые DRM ролики скачать нельзя — это ограничение "
    "по дизайну, а не баг.\n\n"
    "Команды: /start, /help, /status"
)

SUBSCRIBE_REQUIRED = (
    "🔒 Чтобы пользоваться ботом, подпишись на канал и нажми «Проверить подписку»."
)
SUBSCRIBE_OK = "✅ Подписка подтверждена! Присылай ссылку."
SUBSCRIBE_MISSING = "Подписка не найдена. Подпишись на канал и попробуй ещё раз."

NOT_A_LINK = "Это не похоже на ссылку. Пришли URL вида https://..."
CHOOSE_ACTION = "Что скачать?"
CHOOSE_QUALITY = "Выбери максимальное качество видео:"
LINK_EXPIRED = "Ссылка устарела — пришли её ещё раз."
BUSY = "⏳ Уже качаю твой предыдущий файл. Дождись его, пожалуйста."
QUEUED = "⏳ Ставлю в очередь..."
FETCHING = "🔎 Спрашиваю у Cobalt..."
DOWNLOADING = "⬇️ Скачиваю..."
YTDLP_WORKING = "⬇️ Скачиваю с YouTube..."
YTDLP_FALLBACK = "↩️ yt-dlp не справился, пробую через Cobalt..."
UPLOADING = "📤 Отправляю в Telegram..."

RETRY_LOCAL = "🔁 Сервер отдал пустой файл — собираю видео и звук сам..."
EMPTY_FILE = (
    "❌ Cobalt вернул пустой файл даже после локальной сборки.\n\n"
    "Чаще всего это значит, что у инстанса протухла сессия площадки. "
    "Попробуй ещё раз чуть позже."
)

WORKER_RESTARTED = "❌ Загрузчик перезапустился посреди задачи. Пришли ссылку ещё раз."
TIMEOUT = "❌ Слишком долго — источник не ответил. Попробуй ещё раз или выбери качество пониже."
UNKNOWN_ERROR = "❌ Не получилось: {error}"

# https://github.com/imputnet/cobalt — API error codes.
COBALT_ERRORS: dict[str, str] = {
    "error.api.link.invalid": "❌ Cobalt не понял эту ссылку.",
    "error.api.link.unsupported": "❌ Эта площадка не поддерживается твоим инстансом Cobalt.",
    "error.api.service.unsupported": "❌ Эта площадка не поддерживается твоим инстансом Cobalt.",
    "error.api.service.disabled": "❌ Поддержка этой площадки отключена в настройках Cobalt.",
    "error.api.fetch.fail": "❌ Не удалось получить данные от источника. Попробуй позже.",
    "error.api.fetch.critical": "❌ Источник ответил ошибкой. Попробуй позже.",
    "error.api.fetch.empty": "❌ По этой ссылке нет медиа для скачивания.",
    "error.api.fetch.rate": "❌ Источник временно ограничил запросы. Подожди пару минут.",
    "error.api.content.too_long": "❌ Ролик длиннее лимита инстанса Cobalt (DURATION_LIMIT).",
    "error.api.content.video.unavailable": "❌ Видео недоступно.",
    "error.api.content.video.live": "❌ Идущие прямые эфиры скачать нельзя.",
    "error.api.content.video.private": "❌ Видео приватное.",
    "error.api.content.video.age": "❌ Видео с возрастным ограничением — Cobalt его не скачает.",
    "error.api.content.video.region": "❌ Видео заблокировано в регионе сервера.",
    "error.api.content.post.unavailable": "❌ Пост недоступен или удалён.",
    "error.api.content.post.private": "❌ Пост приватный.",
    "error.api.youtube.login": (
        "❌ YouTube требует вход. Этот инстанс Cobalt не может его обслужить — "
        "YouTube здесь качает yt-dlp."
    ),
    "error.api.youtube.no_session_tokens": (
        "❌ Этот инстанс Cobalt не умеет в YouTube: у него нет сервера сессий.\n\n"
        "YouTube здесь качает yt-dlp — проверьте, что <code>YTDLP_FOR_YOUTUBE=true</code>."
    ),
    "error.api.youtube.token_expired": (
        "❌ Сессия YouTube у инстанса Cobalt протухла — YouTube здесь качает yt-dlp."
    ),
    "error.api.youtube.no_hls_streams": "❌ YouTube не отдал подходящие потоки. Попробуй другое качество.",
    "error.api.youtube.codec": "❌ Нет варианта в выбранном кодеке. Попробуй качество пониже.",
    "error.api.youtube.decipher": "❌ Cobalt не смог расшифровать поток YouTube — обнови образ Cobalt.",
    "error.api.auth.jwt.missing": (
        "❌ Инстанс закрыт капчей Turnstile — боту он недоступен.\n\n"
        "Нужен либо API-ключ от владельца инстанса, либо другой адрес в "
        "<code>COBALT_API_URL</code>."
    ),
    "error.api.auth.jwt.invalid": (
        "❌ Инстанс не принял токен сессии: он требует капчу Turnstile, "
        "которую бот пройти не может."
    ),
    "error.api.auth.key.missing": (
        "❌ Инстанс требует API-ключ. Добавь его в <code>COBALT_API_URL</code> "
        "в виде <code>адрес|ключ</code>."
    ),
    "error.api.auth.key.invalid": "❌ Инстанс отклонил API-ключ — проверь его в настройках.",
    "error.api.auth.turnstile.missing": (
        "❌ Инстанс требует прохождения капчи Turnstile — для бота это тупик."
    ),
    "error.api.rate_exceeded": "❌ Слишком много запросов к Cobalt. Подожди немного.",
    "error.api.capacity": "❌ Cobalt перегружен. Попробуй через минуту.",
    "error.api.generic": "❌ Cobalt вернул общую ошибку. Попробуй ещё раз.",
    "error.api.unreachable": "❌ Cobalt недоступен.",
}


def cobalt_error(code: str) -> str:
    known = COBALT_ERRORS.get(code)
    if known:
        return known
    return f"❌ Cobalt вернул ошибку: <code>{code}</code>"


def too_large(size_mb: float | None, limit_mb: int, *, local_api_hint: bool = True) -> str:
    """`local_api_hint` is off in worker mode: a bot served by Telegram
    Serverless cannot move to a local Bot API server."""
    if size_mb:
        head = f"⚠️ Файл весит ~{size_mb:.0f} МБ"
    else:
        head = "⚠️ Файл больше лимита"
    tail = (
        "\n\nℹ️ Владелец бота может поднять лимит до 2 ГБ, подключив локальный Bot API сервер."
        if limit_mb <= 50 and local_api_hint
        else ""
    )
    return (
        f"{head}, а Telegram разрешает боту отправлять не больше {limit_mb} МБ.{tail}\n\n"
        "Попробуй качество пониже или только звук:"
    )
