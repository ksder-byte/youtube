// Settings: defaults here, your values in ./secrets.js (see secrets.example.js
// in the project root).

import secrets from './secrets.js';
import { parseUrl } from './util.js';

export const VIDEO_QUALITIES = ['144', '240', '360', '480', '720', '1080', '1440', '2160', 'max'];
export const AUDIO_FORMATS = ['best', 'mp3', 'ogg', 'wav', 'opus'];
export const AUDIO_BITRATES = ['320', '256', '128', '96', '64', '8'];
export const YOUTUBE_CODECS = ['h264', 'av1', 'vp9'];

// Telegram Serverless reads at most 30 MB of any outbound response.
export const FETCH_CAP_MB = 30;
// What the cloud Bot API accepts from a bot; the worker is bound by it too.
export const UPLOAD_LIMIT_MB = 50;

function choice(value, allowed, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

function flag(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function trimSlash(url) {
  return String(url).trim().replace(/\/+$/, '');
}

/** `url` or `url|key`, comma/newline separated or as an array; first one wins. */
export function parseInstances(list, defaultKey = '') {
  const items = Array.isArray(list) ? list : String(list ?? '').split(/[,\n]/);
  const seen = new Map();
  for (const raw of items) {
    const item = String(raw ?? '').trim();
    if (!item) continue;
    const bar = item.indexOf('|');
    const url = trimSlash(bar === -1 ? item : item.slice(0, bar));
    const key = bar === -1 ? '' : item.slice(bar + 1).trim();
    const parsed = parseUrl(url);
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname) continue;
    if (!seen.has(url)) seen.set(url, { url, apiKey: key || defaultKey || '', label: parsed.host });
  }
  return [...seen.values()];
}

export function buildConfig(s = {}) {
  const workerUrl = s.WORKER_URL ? trimSlash(s.WORKER_URL) : '';
  const workerSecret = String(s.WORKER_SECRET ?? '');
  // push: the bot calls the worker at WORKER_URL (a server with an address).
  // pull: the worker polls the bot for jobs (a home PC behind NAT).
  const workerMode = ['push', 'pull'].includes(s.WORKER_MODE)
    ? s.WORKER_MODE
    : workerUrl ? 'push' : workerSecret.length >= 32 ? 'pull' : '';
  const inline = Number(s.INLINE_LIMIT_MB ?? FETCH_CAP_MB);
  return {
    cobaltInstances: parseInstances(s.COBALT_INSTANCES, s.COBALT_API_KEY),
    workerUrl,
    workerSecret,
    workerMode,
    worker: Boolean(workerSecret && (workerMode === 'pull' || (workerMode === 'push' && workerUrl))),
    // pull: a worker silent for longer than this counts as switched off.
    workerOfflineAfter: 90,
    workerMaxQueue: 30,
    workerPollSeconds: 3,
    youtubeViaWorker: flag(s.YOUTUBE_VIA_WORKER, true),
    requiredChannel: String(s.REQUIRED_CHANNEL ?? '').trim(),
    requiredChannelUrl: String(s.REQUIRED_CHANNEL_URL ?? '').trim(),
    miniAppUrl: s.MINI_APP_URL ? String(s.MINI_APP_URL).trim() : '',
    adminIds: (s.ADMIN_IDS ?? []).map(Number).filter(Number.isFinite),
    defaults: {
      videoQuality: choice(s.VIDEO_QUALITY, VIDEO_QUALITIES, '1080'),
      audioFormat: choice(s.AUDIO_FORMAT, AUDIO_FORMATS, 'mp3'),
      audioBitrate: choice(s.AUDIO_BITRATE, AUDIO_BITRATES, '128'),
      codec: choice(s.YOUTUBE_VIDEO_CODEC, YOUTUBE_CODECS, 'h264'),
    },
    youtubeBetterAudio: flag(s.YOUTUBE_BETTER_AUDIO, false),
    alwaysProxy: flag(s.ALWAYS_PROXY, true),
    inlineLimitMb: Number.isFinite(inline) && inline > 0 ? Math.min(inline, FETCH_CAP_MB) : FETCH_CAP_MB,
    apiTimeoutMs: 45_000,
    // What /diag checks besides the Cobalt instances: tells "this host is
    // unreachable from Telegram's cloud" apart from "outbound HTTP is broken".
    diagUrls: [
      'https://api.telegram.org/',
      'https://example.com/',
      'https://www.cloudflare.com/cdn-cgi/trace',
    ],
  };
}

// A plain object on purpose: tests reassign its fields.
export const config = buildConfig(secrets);
