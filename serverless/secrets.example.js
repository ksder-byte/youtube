// Your bot's settings. Copy this file to tgcloud/lib/secrets.js and fill it in
// (`npm run check` does the copy and checks what you wrote).
//
// Telegram Serverless has no environment variables, so settings live in a
// module. tgcloud/lib/secrets.js is git-ignored but deployed with the rest of
// tgcloud/ by `npm run deploy`: it stays between you and Telegram's cloud.

export default {
  // ── Cobalt ──────────────────────────────────────────────────────────────
  // Instances in priority order: 'https://host' or 'https://host|api-key'.
  // The bot runs in Telegram's cloud, not next to your server, so they must be
  // reachable from the internet. Your own instance from docker-compose.public.yml
  // is https://<PUBLIC_DOMAIN> with the key from cobalt/keys.json.
  COBALT_INSTANCES: [
    // 'https://dl.example.com|00000000-0000-4000-8000-000000000000',
  ],
  // Key for instances listed without their own.
  COBALT_API_KEY: '',

  // ── Download worker ─────────────────────────────────────────────────────
  // The Python app of this repo with BOT_MODE=worker. yt-dlp and ffmpeg cannot
  // run on Serverless, so YouTube goes there, and so do files over 30 MB and
  // tracks that need muxing. Two ways to connect it:
  //   - a home PC with no public address: leave WORKER_URL empty and set only
  //     WORKER_SECRET — the worker polls this bot for jobs (pull mode);
  //   - a server with a domain: WORKER_URL = 'https://dl.example.com/worker'.
  // Leave both empty to use Cobalt only.
  WORKER_URL: '',
  WORKER_SECRET: '', // at least 32 characters, the same as in the worker's .env

  // ── Forced subscription ─────────────────────────────────────────────────
  // '@channel' or '-100…'; empty turns the check off. The bot must be an
  // administrator of the channel.
  REQUIRED_CHANNEL: '',
  REQUIRED_CHANNEL_URL: '',

  // ── Mini App ────────────────────────────────────────────────────────────
  // `npm run deploy` prints it: https://app<app_id>.tgcloud.ai/
  MINI_APP_URL: '',

  // Telegram user ids allowed to run /setup (commands and the menu button).
  ADMIN_IDS: [],

  // ── Defaults (each user can change theirs in /settings or the Mini App) ──
  // VIDEO_QUALITY: '1080',        // 144 … 2160 | max
  // AUDIO_FORMAT: 'mp3',          // best | mp3 | ogg | wav | opus
  // AUDIO_BITRATE: '128',         // 320 | 256 | 128 | 96 | 64 | 8
  // YOUTUBE_VIDEO_CODEC: 'h264',  // h264 | av1 | vp9
  // YOUTUBE_BETTER_AUDIO: false,
  // ALWAYS_PROXY: true,           // pull files through the instance
  // INLINE_LIMIT_MB: 30,          // largest file sent without the worker (30 max)
  // YOUTUBE_VIA_WORKER: true,     // false: YouTube goes to Cobalt too
};
