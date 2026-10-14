// Inline keyboards and their callback_data. The `dl:` format is shared with
// the Python worker (app/keyboards.py), whose "too large" buttons come back here.

import { config } from './config.js';

export const MODE_VIDEO = 'v';
export const MODE_AUDIO = 'a';

export const QUALITY_CHOICES = ['360', '480', '720', '1080', '1440', '2160'];

export function packDownload(mode, quality, token) {
  return `dl:${mode}:${quality}:${token}`;
}

export function unpackDownload(data) {
  const parts = String(data ?? '').split(':');
  if (parts.length !== 4 || parts[0] !== 'dl') return null;
  const [, mode, quality, token] = parts;
  if (mode !== MODE_VIDEO && mode !== MODE_AUDIO) return null;
  return { mode, quality, token };
}

function qualityLabel(quality) {
  return quality === 'max' ? 'макс.' : `${quality}p`;
}

function rank(quality) {
  if (quality === 'max') return 10_000;
  const n = Number(quality);
  return Number.isFinite(n) ? n : 0;
}

/** A web_app button only works in private chats; elsewhere there is none. */
export function appButton(text, query = '', isPrivate = true) {
  if (!config.miniAppUrl || !isPrivate) return null;
  const sep = config.miniAppUrl.includes('?') ? '&' : '?';
  return { text, web_app: { url: query ? `${config.miniAppUrl}${sep}${query}` : config.miniAppUrl } };
}

export function subscribeKb() {
  const rows = [];
  if (config.requiredChannelUrl) rows.push([{ text: '📢 Подписаться', url: config.requiredChannelUrl }]);
  rows.push([{ text: '✅ Проверить подписку', callback_data: 'sub:check' }]);
  return { inline_keyboard: rows };
}

export function actionsKb(token, quality, isPrivate = true) {
  const rows = [
    [
      { text: `🎬 Видео (${qualityLabel(quality)})`, callback_data: packDownload(MODE_VIDEO, quality, token) },
      { text: '🎵 Аудио', callback_data: packDownload(MODE_AUDIO, '-', token) },
    ],
    [{ text: '⚙️ Качество', callback_data: `q:${token}` }],
  ];
  const app = appButton('📱 Открыть в Mini App', `t=${token}`, isPrivate);
  if (app) rows[1].push(app);
  return { inline_keyboard: rows };
}

export function qualityKb(token) {
  const buttons = QUALITY_CHOICES.map((q) => ({ text: `${q}p`, callback_data: packDownload(MODE_VIDEO, q, token) }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  rows.push([
    { text: '🏆 Максимум', callback_data: packDownload(MODE_VIDEO, 'max', token) },
    { text: '🎵 Аудио', callback_data: packDownload(MODE_AUDIO, '-', token) },
  ]);
  return { inline_keyboard: rows };
}

/** Offered when a file did not fit: lower qualities, sound only, a direct link. */
export function fallbackKb(token, currentQuality, { directUrl = null, isPrivate = true } = {}) {
  const lower = ['720', '480', '360'].filter((q) => rank(q) < rank(currentQuality));
  const rows = [];
  if (lower.length) rows.push(lower.map((q) => ({ text: `🎬 ${q}p`, callback_data: packDownload(MODE_VIDEO, q, token) })));
  rows.push([{ text: '🎵 Только звук', callback_data: packDownload(MODE_AUDIO, '-', token) }]);
  if (directUrl && /^https:\/\//i.test(directUrl)) rows.push([{ text: '🔗 Прямая ссылка (временная)', url: directUrl }]);
  const app = appButton('📱 Скачать через Mini App', `t=${token}`, isPrivate);
  if (app) rows.push([app]);
  return { inline_keyboard: rows };
}

export function settingsKb(prefs, isPrivate = true) {
  const mark = (on, text) => (on ? `• ${text} •` : text);
  const qualities = ['480', '720', '1080', '1440', '2160', 'max'].map((q) => ({
    text: mark(prefs.videoQuality === q, qualityLabel(q)),
    callback_data: `set:q:${q}`,
  }));
  const formats = ['mp3', 'opus', 'ogg', 'wav', 'best'].map((f) => ({
    text: mark(prefs.audioFormat === f, f),
    callback_data: `set:a:${f}`,
  }));
  const rows = [qualities.slice(0, 3), qualities.slice(3), formats];
  const app = appButton('📱 Все настройки в Mini App', 'tab=settings', isPrivate);
  if (app) rows.push([app]);
  return { inline_keyboard: rows };
}
