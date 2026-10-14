// Small helpers that do not lean on web APIs the sandbox may lack: the
// runtime is a bare V8 isolate, so URL, timers and crypto are used only when
// they are actually there.

const URL_PARTS = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]*)(?::(\d+))?([^?#]*)/i;

/** { protocol: 'https:', host, hostname, pathname } or null. */
export function parseUrl(value) {
  const text = String(value ?? '').trim();
  if (typeof globalThis.URL === 'function') {
    try {
      const u = new globalThis.URL(text);
      return { protocol: u.protocol, host: u.host, hostname: u.hostname.toLowerCase(), pathname: u.pathname };
    } catch {
      return null;
    }
  }
  const m = URL_PARTS.exec(text);
  if (!m || !m[2]) return null;
  const hostname = m[2].toLowerCase();
  return {
    protocol: `${m[1].toLowerCase()}:`,
    host: m[3] ? `${hostname}:${m[3]}` : hostname,
    hostname,
    pathname: m[4] || '/',
  };
}

export function isHttpUrl(value) {
  const u = parseUrl(value);
  return Boolean(u && (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname);
}

export function sleep(ms) {
  if (typeof globalThis.setTimeout !== 'function') return Promise.resolve();
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export class TimeoutError extends Error {
  constructor(ms) {
    super(`timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'TimeoutError';
  }
}

/** Gives up waiting after `ms`; the work itself is not cancelled. */
export function withTimeout(promise, ms) {
  if (typeof globalThis.setTimeout !== 'function' || !ms) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => globalThis.clearTimeout?.(timer));
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** URL-safe random token; it only has to be unguessable enough for a link id. */
export function randomToken(length = 10) {
  const bytes = new Uint8Array(length);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 63];
  return out;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function mb(bytes) {
  return bytes / 1024 / 1024;
}

export function now() {
  return Math.floor(Date.now() / 1000);
}
