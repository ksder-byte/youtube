// Finding the link in a message and telling YouTube apart.

import { parseUrl } from './util.js';

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const TRAILING_PUNCTUATION = /[.,!?;:»"')\]]+$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

function normalize(raw) {
  let url = String(raw ?? '').trim();
  if (!url) return null;
  // Telegram marks "youtube.com/watch?v=…" as a url entity even without a scheme.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  // A bracket that closes one opened inside the link is part of it (wiki-style URLs).
  while (TRAILING_PUNCTUATION.test(url)) {
    const last = url[url.length - 1];
    if (last === ')' && url.split('(').length > url.split(')').length - 1) break;
    url = url.slice(0, -1);
  }
  const parsed = parseUrl(url);
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname) return null;
  return url.length <= 2048 ? url : null;
}

/** The first link of a message or caption, or null. */
export function extractUrl(message) {
  const text = message?.text ?? message?.caption ?? '';
  const entities = message?.entities ?? message?.caption_entities ?? [];
  for (const entity of entities) {
    // Entity offsets count UTF-16 code units, exactly like JS string indices.
    if (entity.type === 'url') {
      const url = normalize(text.slice(entity.offset, entity.offset + entity.length));
      if (url) return url;
    }
    if (entity.type === 'text_link' && entity.url) {
      const url = normalize(entity.url);
      if (url) return url;
    }
  }
  const match = URL_RE.exec(text);
  return match ? normalize(match[0]) : null;
}

/** Accepts anything a user might paste into the Mini App. */
export function cleanUrl(value) {
  return normalize(value);
}

export function isYoutube(url) {
  const parsed = parseUrl(url);
  return Boolean(parsed && YOUTUBE_HOSTS.has(parsed.hostname));
}

export function hostOf(url) {
  return parseUrl(url)?.hostname?.replace(/^www\./, '') ?? '';
}
