// User-facing strings (HTML parse mode) and Cobalt error-code translations.

export const START =
  '👋 <b>Привет!</b>\n\n' +
  'Пришли ссылку — я скачаю видео или звук и отправлю файлом прямо сюда.\n\n' +
  '🎬 YouTube (включая Shorts) — основной сценарий\n' +
  '📦 Также работают TikTok, Instagram, X/Twitter, VK, Reddit, Twitch-клипы, ' +
  'SoundCloud и другие площадки, которые поддерживает Cobalt.\n\n' +
  'Команды: /help — справка, /settings — качество по умолчанию, /status — состояние.';

export const START_APP = '📱 В Mini App удобно выбрать качество, скачать файл на устройство и посмотреть историю.';

export const HELP =
  '<b>Как пользоваться</b>\n\n' +
  '1. Пришли ссылку на публичный пост или видео.\n' +
  '2. Выбери, что скачать: видео или только звук.\n' +
  '3. Дождись файла.\n\n' +
  '<b>Полезно знать</b>\n' +
  '• Качество можно выбрать кнопкой «⚙️ Качество», а по умолчанию — в /settings.\n' +
  '• Если файл больше лимита Telegram, я предложу качество пониже, звук или прямую ссылку.\n' +
  '• Приватные, платные и защищённые DRM ролики скачать нельзя — это ограничение ' +
  'по дизайну, а не баг.\n\n' +
  'Команды: /start, /help, /settings, /status, /app';

export const SUBSCRIBE_REQUIRED = '🔒 Чтобы пользоваться ботом, подпишись на канал и нажми «Проверить подписку».';
export const SUBSCRIBE_OK = '✅ Подписка подтверждена! Присылай ссылку.';
export const SUBSCRIBE_MISSING = 'Подписка не найдена. Подпишись на канал и попробуй ещё раз.';

export const NOT_A_LINK = 'Это не похоже на ссылку. Пришли URL вида https://...';
export const CHOOSE_ACTION = 'Что скачать?';
export const CHOOSE_QUALITY = 'Выбери максимальное качество видео:';
export const LINK_EXPIRED = 'Ссылка устарела — пришли её ещё раз.';
export const BUSY = '⏳ Уже качаю твой предыдущий файл. Дождись его, пожалуйста.';
export const QUEUED = '⏳ Ставлю в очередь...';
export const FETCHING = '🔎 Спрашиваю у Cobalt...';
export const DOWNLOADING = '⬇️ Скачиваю...';
export const UPLOADING = '📤 Отправляю в Telegram...';
export const HANDING_OFF = '📦 Передаю задачу загрузчику...';
export const HANDING_OFF_LARGE = '📦 Файл крупный — передаю его загрузчику...';

export const NOT_CONFIGURED =
  '⚙️ Бот ещё не настроен: в <code>tgcloud/lib/secrets.js</code> нет ни инстанса Cobalt, ни загрузчика.';
export const WORKER_BUSY = '⏳ Загрузчик уже качает твой предыдущий файл. Дождись его, пожалуйста.';
export const WORKER_OVERLOADED = '⏳ Загрузчик сейчас перегружен. Попробуй через пару минут.';
export const WORKER_UNAVAILABLE = '❌ Загрузчик недоступен. Попробуй позже.';
export const WORKER_OFFLINE = '💤 Загрузчик сейчас не в сети — компьютер, на котором он работает, выключен или без интернета. Попробуй позже.';
export const LOCAL_PROCESSING =
  '❌ Инстанс отдал видео и звук отдельно, а склеивать их здесь нечем.\n\n' +
  'Подключи загрузчик (<code>WORKER_URL</code>) или выключи <code>FORCE_LOCAL_PROCESSING</code> у инстанса.';
export const EMPTY_FILE =
  '❌ Cobalt вернул пустой файл.\n\n' +
  'Чаще всего это значит, что у инстанса протухла сессия площадки. Попробуй ещё раз чуть позже.';
export const TIMEOUT = '❌ Слишком долго — источник не ответил. Попробуй ещё раз или выбери качество пониже.';
export const UNKNOWN_ERROR = (error) => `❌ Не получилось: ${error}`;

export const SETTINGS =
  '<b>Настройки по умолчанию</b>\n\n' +
  'Качество видео: <b>{quality}</b>\nФормат звука: <b>{format}</b>\n\n' +
  'Кнопки под ссылкой используют эти значения. Остальное — в Mini App.';
export const SAVED = '✅ Сохранено';
export const SETUP_DONE = '✅ Команды обновлены{menu}.';
export const ADMIN_ONLY = 'Эта команда только для администраторов бота.';
export const OPEN_APP = '📱 Открой Mini App:';
export const OPEN_APP_PRIVATE = 'Mini App открывается из личного чата с ботом.';
export const NO_APP = 'Mini App ещё не настроен: укажи <code>MINI_APP_URL</code> в <code>tgcloud/lib/secrets.js</code>.';

// https://github.com/imputnet/cobalt — API error codes.
export const COBALT_ERRORS = {
  'error.api.link.invalid': '❌ Cobalt не понял эту ссылку.',
  'error.api.link.unsupported': '❌ Эта площадка не поддерживается инстансом Cobalt.',
  'error.api.service.unsupported': '❌ Эта площадка не поддерживается инстансом Cobalt.',
  'error.api.service.disabled': '❌ Поддержка этой площадки отключена в настройках Cobalt.',
  'error.api.fetch.fail': '❌ Не удалось получить данные от источника. Попробуй позже.',
  'error.api.fetch.critical': '❌ Источник ответил ошибкой. Попробуй позже.',
  'error.api.fetch.empty': '❌ По этой ссылке нет медиа для скачивания.',
  'error.api.fetch.rate': '❌ Источник временно ограничил запросы. Подожди пару минут.',
  'error.api.content.too_long': '❌ Ролик длиннее лимита инстанса Cobalt (DURATION_LIMIT).',
  'error.api.content.video.unavailable': '❌ Видео недоступно.',
  'error.api.content.video.live': '❌ Идущие прямые эфиры скачать нельзя.',
  'error.api.content.video.private': '❌ Видео приватное.',
  'error.api.content.video.age': '❌ Видео с возрастным ограничением — Cobalt его не скачает.',
  'error.api.content.video.region': '❌ Видео заблокировано в регионе сервера.',
  'error.api.content.post.unavailable': '❌ Пост недоступен или удалён.',
  'error.api.content.post.private': '❌ Пост приватный.',
  'error.api.youtube.login': '❌ YouTube требует вход — этот инстанс Cobalt не может его обслужить.',
  'error.api.youtube.no_session_tokens':
    '❌ Этот инстанс Cobalt не умеет в YouTube: у него нет сервера сессий.\n\n' +
    'Подключи загрузчик (<code>WORKER_URL</code>) — там YouTube качает yt-dlp.',
  'error.api.youtube.token_expired': '❌ Сессия YouTube у инстанса Cobalt протухла.',
  'error.api.youtube.no_hls_streams': '❌ YouTube не отдал подходящие потоки. Попробуй другое качество.',
  'error.api.youtube.codec': '❌ Нет варианта в выбранном кодеке. Попробуй качество пониже.',
  'error.api.youtube.decipher': '❌ Cobalt не смог расшифровать поток YouTube — обнови образ Cobalt.',
  'error.api.auth.jwt.missing':
    '❌ Инстанс закрыт капчей Turnstile — боту он недоступен.\n\n' +
    'Нужен API-ключ от владельца инстанса (<code>адрес|ключ</code>) или другой инстанс.',
  'error.api.auth.jwt.invalid': '❌ Инстанс требует капчу Turnstile, которую бот пройти не может.',
  'error.api.auth.key.missing':
    '❌ Инстанс требует API-ключ. Укажи его в <code>COBALT_INSTANCES</code> как <code>адрес|ключ</code>.',
  'error.api.auth.key.invalid': '❌ Инстанс отклонил API-ключ — проверь его в настройках.',
  'error.api.auth.turnstile.missing': '❌ Инстанс требует прохождения капчи Turnstile — для бота это тупик.',
  'error.api.rate_exceeded': '❌ Слишком много запросов к Cobalt. Подожди немного.',
  'error.api.capacity': '❌ Cobalt перегружен. Попробуй через минуту.',
  'error.api.generic': '❌ Cobalt вернул общую ошибку. Попробуй ещё раз.',
  'error.api.unreachable': '❌ Cobalt недоступен.',
};

export function cobaltError(code) {
  return COBALT_ERRORS[code] ?? `❌ Cobalt вернул ошибку: <code>${String(code).replace(/[<>&]/g, '')}</code>`;
}

export function tooLarge(sizeMb, limitMb) {
  const head = sizeMb ? `⚠️ Файл весит ~${Math.round(sizeMb)} МБ` : '⚠️ Файл больше лимита';
  return `${head}, а отправить я могу не больше ${limitMb} МБ.\n\nПопробуй качество пониже, только звук или скачай по ссылке:`;
}

export function pickerSkipped(count) {
  return `⚠️ ${count} файл(ов) пропущено — больше лимита.`;
}

export function downloadingProgress(percent) {
  return `${DOWNLOADING} ${percent}%`;
}
