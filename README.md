# Cobalt Telegram Bot

Телеграм-бот, который скачивает медиа через [Cobalt](https://github.com/imputnet/cobalt)
и yt-dlp и присылает файл прямо в чат. Главный сценарий — **YouTube** (включая
Shorts), остальные площадки работают как бонус: TikTok, Instagram, X/Twitter,
VK, Reddit, Twitch-клипы, SoundCloud, Pinterest, Bilibili и всё остальное, что
умеет ваша версия Cobalt. Есть **Mini App**: вставить ссылку, выбрать качество
и скачать файл на устройство или в чат.

Запускается двумя способами:

| | Telegram Serverless (новое) | Классический |
|---|---|---|
| Где живёт бот | у Telegram: `serverless/`, JavaScript | у вас: `app/`, aiogram, long polling |
| Mini App | да, хостится там же | нет |
| Ваш сервер | загрузчик (yt-dlp + ffmpeg) и Cobalt за HTTPS | всё целиком |
| Лимит файла в чат | 30 МБ из облака, 50 МБ через загрузчик | 50 МБ, с локальным Bot API — 2 ГБ |

```
Telegram Serverless:
                                  ┌── YouTube, > 30 МБ, склейка ─→ загрузчик на вашем сервере ─┐
пользователь → бот / Mini App ────┤   (BOT_MODE=worker: yt-dlp + ffmpeg)                       ├→ файл в чат
  (код у Telegram, serverless/)   └── остальное ─→ Cobalt ─→ ≤ 30 МБ отправляет сам бот ───────┘
                                       Mini App: «Скачать на устройство» — прямо из Cobalt, без лимита 50 МБ

Классический:
                   ┌── YouTube ──→ yt-dlp (внутри бота, ffmpeg рядом)
пользователь → бот ┤
                   └── остальное ─→ cobalt API
```

Почему не «всё в Serverless»: там работает только JavaScript в песочнице V8 —
ни Python, ни yt-dlp, ни ffmpeg, а ответ любого внешнего запроса ограничен
30 МБ. Поэтому бот, кнопки, настройки, история и Mini App переехали к Telegram,
а тяжёлая работа осталась на вашем сервере — тем же Python-кодом, что и раньше.

## Что умеет

- 🎬 видео с выбором качества (360p … 2160p / «максимум»);
- 🎵 только звук (mp3/opus/ogg/wav) одной кнопкой;
- 🖼 галереи и карусели (`picker`) — отправляет альбомами по 10 штук;
- 🧩 сам склеивает видео и звук через ffmpeg: и когда инстанс вернул `local-processing`,
  и как запасной путь, если серверный ремукс отдал пустой файл;
- 📏 жёсткий лимит на размер: качает потоком и обрывает загрузку, как только файл
  перевалил лимит, а потом предлагает качество пониже или аудио;
- 🖼 достаёт длительность, разрешение и обложку через ffprobe — Telegram
  показывает нормальный превью-плеер, а не серый прямоугольник;
- 🔁 несколько инстансов Cobalt с автоматическим переключением: не смог свой —
  запрос уходит на запасной;
- 🔒 опциональная обязательная подписка на канал;
- ♻️ ретраи и понятные сообщения на все коды ошибок Cobalt (на русском);
- 🚦 ограничение параллельных загрузок и один активный запрос на пользователя.

## Что нового в 2.0

- **Telegram Serverless**: бот переписан на JavaScript-модули платформы
  (`serverless/`), состояние — во встроенной базе SQLite;
- **Mini App** (`serverless/miniapp/`): ссылка → видео или звук → скачать на
  устройство (`WebApp.downloadFile`, без лимита Bot API) или в чат; история,
  настройки по умолчанию, галереи;
- **режим загрузчика** `BOT_MODE=worker`: Python-часть принимает задачи от
  серверлесс-бота по HTTPS и сама отправляет файл в чат;
- `docker-compose.public.yml` + Caddy: загрузчик и Cobalt (только по API-ключу)
  на одном HTTPS-домене с автоматическим сертификатом;
- обновлены компоненты: Python 3.14, aiogram 3.31, aiohttp 3.14, python-dotenv
  1.2.4, pytest 9.1, pytest-asyncio 1.4; yt-dlp ставится с `[default,deno]` —
  yt-dlp-ejs и JavaScript-рантайм deno, без которых YouTube сейчас отдаёт
  урезанный набор форматов;
- исправлено: дублированные методы клиента Cobalt, сломанный
  `app/wait_for_session.py`, обрезанные тексты, `docker-compose.yml`
  игнорировал список `COBALT_API_URL` из `.env`;
- в режиме polling бот теперь отказывается удалять чужой вебхук — он не
  «уведёт» бота у Serverless, если случайно запустить старый контейнер.

## Деплой в Telegram Serverless

Понадобится: сервер с Docker и доменом (для загрузчика и Cobalt), Node.js 22.13+
на вашем компьютере и бот, у которого в @BotFather включён Serverless.

> Остановите старый контейнер с ботом (`docker compose down`), прежде чем
> переносить бота: у бота может быть только один способ получать апдейты, и в
> Serverless это вебхук платформы.

### 1. Сервер: загрузчик и Cobalt за HTTPS

```bash
./setup.sh public      # создаст .env и cobalt/keys.json, напечатает недостающие строки
nano .env              # BOT_TOKEN и строки, которые напечатал скрипт
```

В `.env` должно оказаться:

```env
BOT_TOKEN=...                 # тот же бот
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=docker-compose.yml:docker-compose.public.yml
PUBLIC_DOMAIN=dl.example.com  # A/AAAA-запись домена → IP сервера
WORKER_SECRET=...             # ≥ 32 символов, скрипт сгенерирует
COBALT_API_KEY=...            # UUID из cobalt/keys.json
```

```bash
docker compose build && docker compose up -d
curl https://dl.example.com/worker/healthz        # → {"ok": true}
```

Порты 80 и 443 должны быть открыты: Caddy сам получит сертификат Let's Encrypt.
Cobalt наружу пускает только с ключом из `cobalt/keys.json`; загрузчик — только
с `WORKER_SECRET`. На Windows вместо `./setup.sh public` —
`.\setup.ps1 public`.

### 2. Проект Serverless

> Все команды ниже — **из папки `serverless`**. В другой папке `npx tgcloud`
> не найдёт CLI проекта и скачает с npm посторонний пакет с тем же именем
> (`tgcloud`, не от Telegram). Поэтому дальше везде `npm run …`: эти команды
> всегда берут CLI проекта.

В @BotFather: ваш бот → **Serverless** → включить; там же **CLI Access** →
скопировать токен доступа (это не токен бота).

```bash
cd serverless
npm install
npx tgcloud init --no-git   # создаст служебную .tgcloud/, ваши файлы не трогает
npx tgcloud login           # вставить токен из CLI Access
npm run check               # создаст tgcloud/lib/secrets.js из шаблона
```

Заполните `tgcloud/lib/secrets.js` (в git не попадает, но деплоится вместе с
кодом — переменных окружения у платформы нет):

```js
export default {
  COBALT_INSTANCES: ['https://dl.example.com|<COBALT_API_KEY>'],
  WORKER_URL: 'https://dl.example.com/worker',
  WORKER_SECRET: '<тот же WORKER_SECRET, что в .env>',
  REQUIRED_CHANNEL: '',          // '@channel' — обязательная подписка
  REQUIRED_CHANNEL_URL: '',
  ADMIN_IDS: [123456789],        // ваш Telegram id — для /setup
  MINI_APP_URL: '',              // заполните после первого деплоя
};
```

### 3. Деплой

```bash
npm run deploy        # проверит secrets.js и зальёт код + Mini App; напечатает адрес Mini App
npm run migrate       # создаст таблицы в базе (спросит подтверждение)
```

Впишите напечатанный адрес `https://app<id>.tgcloud.ai/` в `MINI_APP_URL`,
снова `npm run deploy` и отправьте боту **/setup** — он обновит список команд и
кнопку меню, ведущую в Mini App. По желанию в @BotFather назначьте этот же
адрес как Main Mini App.

Проверка — **/status** в боте: там видны инстансы Cobalt и загрузчик.

### Обновление и отладка

- код поменялся → `npm run deploy`; поменялась `tgcloud/schema.js` → ещё и
  `npm run migrate`;
- `npx tgcloud run handlers/message '{ chat: { id: 1, type: "private" }, from: { id: 1 }, text: "/help" }'`
  выполнит обработчик в облаке на ваших локальных файлах, без деплоя;
- `npx tgcloud webhook` — состояние вебхука; `npx tgcloud webhook sync` чинит
  его, если кто-то вызвал `setWebhook`/`deleteWebhook` вручную;
- `npm test` — 64 теста серверлесс-кода на Node (SDK платформы подменён
  заглушками, Cobalt и загрузчик — локальные серверы);
- `npm run preview` — Mini App в обычном браузере на настоящих эндпоинтах и
  фейковом Cobalt (или вашем: `COBALT_INSTANCES='https://…|ключ' npm run preview`).

### Загрузчик на домашнем ПК (без домена и открытых портов)

Если сервера нет, но есть компьютер, на котором бот работал раньше, загрузчик
можно запустить на нём. Он сам раз в несколько секунд забирает у бота задачи
(режим pull): адрес, домен и проброс портов не нужны, достаточно выхода в
интернет. YouTube снова качает yt-dlp, остальное — Cobalt на том же ПК, файлы
до 50 МБ. Бот и Mini App отвечают круглосуточно, а скачивание работает, пока
включён ПК; если он выключен, бот так и скажет.

1. В `serverless/tgcloud/lib/secrets.js`: `WORKER_URL` пустой, `WORKER_SECRET` —
   случайная строка от 32 символов (в PowerShell:
   `[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')`),
   `COBALT_INSTANCES: []` (всё пойдёт на ПК). Затем `npm run deploy` и
   `npm run migrate` — появятся таблицы очереди.
2. В `.env` в корне репозитория на ПК (можно взять старый):

   ```env
   BOT_TOKEN=...                                  # тот же бот
   BOT_MODE=worker
   WORKER_SECRET=...                              # тот же, что в secrets.js
   WORKER_SERVERLESS_URL=https://app<id>.tgcloud.ai   # адрес Mini App
   COBALT_API_URL=http://cobalt:9000
   ```

   `<id>` — цифры из токена CLI Access (`app<id>:…`); тот же адрес печатает
   `npm run deploy`.
3. `docker compose up -d --build`, затем `docker compose logs -f bot` — в логе
   должно быть `Worker polling https://app<id>.tgcloud.ai/api/workerPoll`.
4. `/status` в боте: «Загрузчик (на вашем ПК…) ✅ на связи».

Загрузчик подписывает свои запросы токеном бота так же, как Telegram
подписывает данные Mini App, поэтому платформа пропускает их к эндпоинту
`workerPoll`, а `WORKER_SECRET` отличает их от вызовов пользователей.

### Без своего сервера

Можно и так: оставьте `WORKER_URL` пустым и укажите в `COBALT_INSTANCES`
публичный инстанс — лучше с API-ключом от его владельца (`адрес|ключ`). Тогда
всё работает из облака Telegram, но:

- YouTube — только пока у инстанса жива YouTube-сессия (на публичных она то
  есть, то `error.api.youtube.login`);
- файлы в чат — до 30 МБ, склеивать дорожки нечем; Mini App при этом скачивает
  на устройство файлы любого размера;
- без ключа действует общий лимит инстанса (обычно 20 запросов в минуту с одного
  IP), а запросы всех ботов в Serverless идут с IP Telegram — при нагрузке бот
  ответит «Слишком много запросов к Cobalt»;
- поставьте `ALWAYS_PROXY: false` в `secrets.js`: файлы пойдут по прямым
  ссылкам площадок, а не через канал владельца инстанса.

Список инстансов сообщества — https://cobalt.directory. Те, что закрыты капчей
Turnstile, боту без ключа недоступны; уважайте условия владельца.

### Лимиты Serverless

| Что | Сколько | Что делает бот |
|---|---|---|
| ответ внешнего запроса из облака | 30 МБ | больше — отдаёт загрузчику (если он есть) или предлагает качество ниже, звук и прямую ссылку |
| отправка файла ботом | 50 МБ | больше — только «Скачать на устройство» в Mini App |
| локальный Bot API (2 ГБ) | недоступен | он требует `logOut` из облачного API, а вебхук Serverless живёт именно там |
| время выполнения обработчика | платформа не публикует | крупные файлы лучше отдавать загрузчику: `INLINE_LIMIT_MB` в `secrets.js` |

## Классический режим: бот целиком на вашем сервере

Всё как раньше — один `docker compose`, бот получает апдейты через long polling.

Linux / macOS:

```bash
git clone https://github.com/ksder-byte/youtube
cd youtube
./setup.sh             # создаст .env (на Windows: .\setup.ps1)
nano .env              # минимум — BOT_TOKEN

docker compose build   # 3-5 минут: ставится ffmpeg
docker compose up -d   # секунды
docker compose logs -f bot
```

Windows (PowerShell), из папки с `docker-compose.yml`:

```powershell
Copy-Item .env.example .env
notepad .env           # минимум — BOT_TOKEN, сохранить
docker compose up -d --build
docker compose logs -f bot
```

`.env` намеренно не создаётся сам: иначе бот стартовал бы с чужим токеном из
примера. Копируйте файл именно `Copy-Item` или `cp` — `Set-Content` в Windows
PowerShell 5.1 сохраняет UTF-8 **с BOM**, и невидимый символ приклеивается к
первой переменной. Бот такой файл переживёт, а вот другие инструменты — не
обязательно.

Долгая только сборка образа. Дальше стек поднимается за секунды: ждать нечего,
YouTube-сессия живёт внутри yt-dlp.

Проверить, что всё живо: `/status` прямо в боте.

## Публичные инстансы как запасной вариант

Свой инстанс — это приватность и отсутствие лимитов, но именно он ломается,
когда протухает сессия YouTube. Поэтому `COBALT_API_URL` принимает список:

```env
COBALT_API_URL=http://cobalt:9000, https://api.example.org, https://other.example|их_ключ
```

Часть публичных инстансов закрыта капчей Turnstile: они отвечают
`error.api.auth.jwt.missing` и годятся только для браузера. Такой адрес бот
автоматически откладывает и идёт к следующему — но лучше не держать его в
списке вовсе, а попросить у владельца API-ключ и указать его как `адрес|ключ`.

Первый адрес обслуживает все запросы. На следующий бот уходит только если
предыдущий не справился: нет сессии YouTube, лимит запросов, 5xx, таймаут,
инстанс не поддерживает площадку. На ошибках самой ссылки (приватное видео,
неподдерживаемый сайт, слишком длинный ролик) перебора **не будет** — такой
ответ одинаков везде. Инстанс, который упал или ответил 429, отправляется в
бан на 5 минут, но если живых не осталось, бот всё равно попробует его.

Список публичных инстансов ведёт сообщество на **https://cobalt.directory**.
Прежде чем вписывать адрес, проверьте его:

```bash
python -m app.instances https://api.example.org
python -m app.instances --youtube https://api.example.org   # проверить именно YouTube
```

Без установленного Python то же самое запускается внутри образа:

```powershell
docker compose run --rm --no-deps bot python -m app.instances --youtube https://api.example.org
```

Учтите: у инстанса адрес сайта и адрес API часто разные (`cobalt.example.com`
против `api.example.com`). В `COBALT_API_URL` нужен именно API — если попадёте
на сайт, проверялка ответит «отдаёт HTML вместо JSON» и попробует угадать
верный адрес.

Если публичный инстанс у вас основной, подумайте про `ALWAYS_PROXY=false`: тогда
бот пойдёт по прямой ссылке там, где Cobalt её отдаёт, и не будет прокачивать
через чужой сервер каждый мегабайт. YouTube это почти не затрагивает — там
файл всё равно идёт через инстанс, — а вот TikTok и прочие площадки перестанут
грузить чужой канал.

Трезво о рисках: публичный инстанс видит **каждую ссылку ваших пользователей**
и IP вашего бота, платит за трафик из своего кармана и вправе вас
заблокировать. Держите свой инстанс первым, а чужой — страховкой, соблюдайте
условия владельца и не гоняйте через него весь поток. Официальный
`api.cobalt.tools` для сторонних проектов использовать не следует.

## Обновление

`.env` не входит в поставку — иначе бот стартовал бы с чужим токеном. Поэтому
при распаковке новой версии поверх папки он не появится, а если вы перед этим
удалили папку целиком, то и пропадёт. Сохраните его заранее:

После распаковки новой версии — одна строка:

```powershell
.\setup.ps1 ; docker compose build ; docker compose up -d
```

`setup.ps1` создаст `.env`, если его нет, и не тронет существующий.

На Linux/macOS то же самое делает `./setup.sh` (или `make init`).

Скрипт безопасно запускать сколько угодно раз: имеющийся `.env` он не
перезаписывает, а если в токене остался плейсхолдер — предупредит.

Проверка `env file ... .env not found` при `docker compose up` означает ровно
это: конфига рядом с `docker-compose.yml` нет.

Диагностику можно запускать и без `.env` — минуя compose:

```powershell
docker run --rm cobalt-telegram-bot:latest python -m app.instances --youtube https://api.example.org
```

## Настройка

Токен бота берётся у [@BotFather](https://t.me/BotFather). Все параметры —
в `.env`:

| Переменная | По умолчанию | Зачем |
|---|---|---|
| `BOT_TOKEN` | — | **обязательно**, токен от @BotFather |
| `BOT_MODE` | `polling` | `worker` — только загрузчик для бота в Serverless (`docker-compose.public.yml` ставит сам) |
| `WORKER_SECRET` | — | общий секрет с `serverless/tgcloud/lib/secrets.js`, ≥ 32 символов; обязателен для `worker` |
| `WORKER_SERVERLESS_URL` | пусто | адрес Mini App бота (`https://app<id>.tgcloud.ai`): загрузчик сам забирает задачи, адрес и порты не нужны |
| `WORKER_POLL_SECONDS` | `3` | как часто загрузчик спрашивает бота о новых задачах |
| `WORKER_PORT` / `WORKER_MAX_QUEUE` | `8080` / `20` | порт загрузчика (без `WORKER_SERVERLESS_URL`) и сколько задач он берёт одновременно |
| `PUBLIC_DOMAIN` | — | домен для `docker-compose.public.yml`: Caddy, сертификат, адрес туннелей Cobalt |
| `TAKE_OVER_WEBHOOK` | `false` | разово разрешить polling-боту снять чужой вебхук (вернуть бота из Serverless) |
| `COBALT_API_URL` | `http://cobalt:9000` | список инстансов через запятую, по приоритету; можно `url\|ключ` |
| `COBALT_API_KEY` | пусто | ключ по умолчанию для инстансов без собственного |
| `REQUIRED_CHANNEL` | пусто | `@channel` или `-100…`; пусто — проверка выключена |
| `REQUIRED_CHANNEL_URL` | пусто | ссылка для кнопки «Подписаться» |
| `MAX_DOWNLOAD_MB` | `50` | сколько бот готов скачать и отправить |
| `TELEGRAM_API_URL` | пусто | адрес локального Bot API сервера; с ним потолок 2000 МБ |
| `TELEGRAM_API_LOCAL_MODE` | `true` | сервер запущен с `TELEGRAM_LOCAL=1` |
| `TELEGRAM_TIMEOUT` | `900` | таймаут запроса к Bot API, секунды |
| `VIDEO_QUALITY` | `1080` | качество по умолчанию |
| `AUDIO_FORMAT` / `AUDIO_BITRATE` | `mp3` / `128` | параметры звука |
| `YOUTUBE_VIDEO_CODEC` | `h264` | `h264` играет везде; `av1`/`vp9` легче, но капризнее |
| `YOUTUBE_BETTER_AUDIO` | `false` | звук повышенного битрейта; требует транскода на стороне Cobalt |
| `YTDLP_FOR_YOUTUBE` | `true` | качать YouTube через yt-dlp, а не через Cobalt |
| `YTDLP_FALLBACK_TO_COBALT` | `false` | если yt-dlp не смог — попробовать Cobalt |
| `YTDLP_COOKIES_FILE` | пусто | файл cookies для контента, который доступен вашему аккаунту |
| `ALWAYS_PROXY` | `true` | тянуть файл через инстанс, а не по прямой ссылке; надёжнее, но весь трафик оплачивает инстанс |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | сколько задач качается одновременно |
| `API_TIMEOUT` / `DOWNLOAD_TIMEOUT` | `60` / `900` | таймауты в секундах |
| `LOG_LEVEL` | `INFO` | `DEBUG` для отладки |

### Обязательная подписка

Добавьте бота **администратором** канала — без этого `getChatMember` не отдаёт
статус участника. Если бот не админ или `REQUIRED_CHANNEL` указан неверно,
проверка не блокирует пользователей: в логах появится `Cannot verify
subscription …`, а бот продолжит работать. Так неправильная настройка не
превращает бота в кирпич — но и подписку не проверяет, поэтому лог стоит
почитать.

### Файлы больше 50 МБ

> Только для классического режима: локальный Bot API несовместим с Telegram
> Serverless. Там большие файлы скачиваются на устройство через Mini App.

Облачный Bot API не даёт боту отправить файл крупнее 50 МБ. Поднять потолок до
2 ГБ можно только одним способом — **локальным Bot API сервером**. Он в
`docker-compose.yml` уже есть, под профилем `local-api`.

**1. Получите api_id и api_hash** на https://my.telegram.org/apps (это данные
вашего аккаунта Telegram, не бота) и впишите в `.env`:

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
```

**2. Выведите бота из облачного API.** Telegram разрешает боту работать только
с одним сервером за раз, поэтому нужен разовый `logOut`:

```bash
docker compose run --rm --no-deps bot python -m app.logout --yes
```

**3. Включите сервер и поднимите лимит** в `.env`:

```env
TELEGRAM_API_URL=http://telegram-bot-api:8081
MAX_DOWNLOAD_MB=2000
COMPOSE_PROFILES=local-api
```

```bash
docker compose up -d
```

`COMPOSE_PROFILES` в `.env` включает профиль насовсем. Без него сервер
поднимается только явным `docker compose --profile local-api up -d`, а
обычный `up` оставит бота без API — и он не запустится.

Проверка — `/status`: там появится строка «Локальный Bot API» с новым лимитом.

**Как вернуться обратно** в облако: `python -m app.logout --close --yes`, затем
убрать `TELEGRAM_API_URL` и `COMPOSE_PROFILES`, вернуть `MAX_DOWNLOAD_MB=50` и
перезапустить. Учтите: после `logOut` облачный API не пускает бота обратно
около 10 минут — это ограничение Telegram, не бага.

Что стоит иметь в виду:

- сервер хранит файлы у себя (том `telegram-bot-api-data`) и сам их не чистит —
  следите за местом;
- отдача 2 ГБ в Telegram занимает минуты; таймаут задаётся `TELEGRAM_TIMEOUT`;
- `api_id`/`api_hash` — это доступ к вашему аккаунту, держите `.env` при себе;
- **получатель тоже упрётся в лимиты**: в обычном Telegram файл до 2 ГБ, с
  Premium — до 4 ГБ.

Если сервер не поднимать, бот при слишком большом файле сам предложит
720p/480p/360p или только звук — это остаётся рабочим сценарием.

## Разработка

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
pytest                       # 123 теста, сеть не нужна: Cobalt поднимается фейковый
BOT_TOKEN=... COBALT_API_URL=http://127.0.0.1:9000 python -m app
```

Структура:

```
app/
├── __main__.py     запуск, DI, long polling или загрузчик
├── worker.py       загрузчик: HTTP-приём задач от бота в Serverless
├── config.py       настройки из окружения
├── cobalt.py       клиент Cobalt API v11: перебор инстансов, разбор статусов
├── instances.py    CLI-проверка инстансов (python -m app.instances)
├── logout.py       переключение между облачным и локальным Bot API
├── downloader.py   потоковая загрузка с обрывом по лимиту
├── media.py        ffprobe/ffmpeg: метаданные, обложки, склейка дорожек
├── handlers.py     хендлеры и конвейер загрузки
├── keyboards.py    инлайн-клавиатуры и callback_data
├── storage.py      TTL-хранилище ссылок и антифлуд
└── texts.py        тексты и перевод кодов ошибок Cobalt

serverless/                проект Telegram Serverless (npm, tgcloud)
├── tgcloud/
│   ├── handlers/          message.js, callback_query.js — апдейты бота
│   ├── endpoints/         функции, которые вызывает Mini App
│   ├── lib/               cobalt, pipeline, store, keyboards, texts, worker…
│   └── schema.js          таблицы базы
├── miniapp/               Mini App: HTML/CSS/JS без сборки
├── secrets.example.js     шаблон tgcloud/lib/secrets.js
└── test/                  тесты на Node и превью Mini App
```

## Про yt-dlp

YouTube регулярно ломает старые версии yt-dlp — это норма жизни, а не поломка
бота. Поэтому версия в `requirements.txt` задана как `>=`, и образ стоит
пересобирать раз в пару недель:

```bash
docker compose build --pull bot && docker compose up -d bot
```

Текущую версию видно по `/status`. Если YouTube начал отвечать «confirm you're
not a bot», сначала обновите образ; если не помогло — подложите cookies:

```yaml
# docker-compose.yml, сервис bot
volumes:
  - ./cookies.txt:/cookies.txt:ro
```

```env
YTDLP_COOKIES_FILE=/cookies.txt
```

Cookies дают доступ ровно к тому, что видит ваш аккаунт, — это не обход
ограничений, и на приватное чужое видео они прав не добавят.

`YTDLP_FOR_YOUTUBE=false` вернёт YouTube в Cobalt — но учтите, что голый Cobalt
этого не умеет: ему нужен свой сервер сессий
([`yt-session-generator`](https://github.com/imputnet/yt-session-generator) из
документации Cobalt), которого в этом compose-файле намеренно нет.

## Диагностика

| Симптом | Причина и что делать |
|---|---|
| `env file ... \.env not found` при `docker compose up` | нет файла `.env`: `Copy-Item .env.example .env` (Windows) или `cp .env.example .env`, затем вписать `BOT_TOKEN` |
| `Configuration error: BOT_TOKEN is not set` | `.env` есть, но переменная пустая или файл лежит не рядом с `docker-compose.yml` |
| `no_session_tokens` / `❌ YouTube требует вход` | ссылка ушла в Cobalt, а не в yt-dlp. Проверьте `YTDLP_FOR_YOUTUBE=true` и что домен ссылки — реальный YouTube |
| `Bad Request: file must be non-empty` в логах | Cobalt отдал пустой туннель (умер его внутренний ремукс). Бот это ловит, перезапрашивает дорожки и склеивает их своим ffmpeg; если и это пусто — почти всегда протухшая сессия YouTube |
| `❌ Cobalt недоступен` | ни один инстанс из списка не ответил; проверьте `/status`, `docker compose ps` и `python -m app.instances` |
| `отдаёт HTML вместо JSON` при проверке инстанса | в `COBALT_API_URL` попал адрес веб-морды, а не API. Проверялка сама пробует `<адрес>/api` и `api.<домен>` и подскажет рабочий; иначе ищите адрес API в директории — он часто на другом домене |
| `Cloudflare показывает проверку браузера` | инстанс закрыт от автоматических клиентов — берите другой |
| YouTube: `confirm you're not a bot` | устаревший yt-dlp — пересоберите образ; в упорных случаях подключите cookies |
| `↩️ yt-dlp не справился, пробую через Cobalt` | штатное поведение: движок не смог, работает запасной путь. Причину видно в логах бота |
| Бот молчит после `logout`, в логах отказ подключения к `telegram-bot-api` | сервер не поднят: проверьте `COMPOSE_PROFILES=local-api` в `.env` или запускайте с `--profile local-api` |
| Контейнер `telegram-bot-api` сразу падает | не заполнены `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`; смотрите `docker compose logs telegram-bot-api` |
| `Request Entity Too Large` при отправке | файл больше того, что примет ваш Bot API. Либо ниже качество, либо локальный сервер (см. «Файлы больше 50 МБ») |
| `error.api.auth.jwt.missing` при проверке инстанса | инстанс закрыт капчей Turnstile и работает только из браузера. Обходить капчу бот не будет: попросите у владельца API-ключ (`адрес\|ключ`) или возьмите другой инстанс |
| Файл приходит документом, а не видео | в контейнере нет ffmpeg — пересоберите образ (`docker compose build --no-cache bot`) |
| `error.api.content.too_long` | ролик длиннее `DURATION_LIMIT` в `docker-compose.yml` |
| Бот молчит на ссылку | включена обязательная подписка; посмотрите логи бота |
| `The bot already has a webhook: …tgcloud…` при старте контейнера | бот живёт в Serverless, а контейнер запущен в режиме polling. Нужен `BOT_MODE=worker` (через `docker-compose.public.yml`) |
| Бот в Serverless молчит | `npx tgcloud webhook`: вебхук должен быть «In sync». Если нет — `npx tgcloud webhook sync`. Проверьте, что старый polling-контейнер остановлен |
| `/status`: `❌ … fetch: request failed` | облако Telegram не достучалось до адреса. Отправьте боту **/diag** (только для `ADMIN_IDS`): он проверит из облака api.telegram.org, example.com, Cloudflare и ваши инстансы и покажет причину ошибки. Если не открывается только инстанс — его хостинг или Cloudflare не пускают адреса Telegram, возьмите другой |
| `💤 Загрузчик сейчас не в сети` | загрузчик на ПК не опрашивал бота дольше 90 секунд: ПК выключен, нет интернета или контейнер остановлен (`docker compose ps`, `docker compose logs bot`) |
| В логе загрузчика `rejected the worker's init data` | в `.env` на ПК токен другого бота: `BOT_TOKEN` должен быть от того бота, в котором включён Serverless |
| В логе загрузчика `WORKER_SECRET differs` | секреты в `.env` и в `secrets.js` не совпадают |
| `❌ Загрузчик недоступен` | `curl https://<PUBLIC_DOMAIN>/worker/healthz`; `WORKER_URL` в `secrets.js` должен оканчиваться на `/worker`, `WORKER_SECRET` — совпадать с `.env` |
| `⚙️ Бот ещё не настроен` | в `tgcloud/lib/secrets.js` пусто — `npm run check` подскажет, чего не хватает |
| Нет кнопок Mini App | не заполнен `MINI_APP_URL` в `secrets.js`; кнопки Mini App показываются только в личных чатах |
| Mini App: «Сначала открой чат с ботом» | пользователь ни разу не нажимал «Старт» у бота; Mini App попросит разрешение писать ему и повторит |

## Правовая часть

Cobalt рассчитан на **публично доступный** контент. Обход авторизации, DRM и
скачивание закрытых материалов сюда не добавляются. Скачивайте только то, на
что у вас есть право, и уважайте условия использования площадок.

Исходный Cobalt распространяется под **AGPL-3.0** — если вы публикуете
production-инстанс или производный проект, проверьте требования лицензии.
Публичный `api.cobalt.tools` для сторонних проектов использовать не следует:
поднимайте свой инстанс, как в `docker-compose.yml`.
