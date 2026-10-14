// Pulling a file into memory with a hard size cap.
//
// There is no disk here: a file is read into one Uint8Array and handed to the
// Bot API as an InputFile. The platform caps an outbound response at 30 MB, so
// that is the ceiling for anything sent without the worker.

import { fetch } from 'sdk';

export class FileTooLarge extends Error {
  constructor(sizeBytes, limitBytes) {
    super('file exceeds the limit');
    this.name = 'FileTooLarge';
    this.sizeBytes = sizeBytes ?? null;
    this.limitBytes = limitBytes;
  }
}

/** The server said 200 and sent nothing: Cobalt's remux died mid-stream. */
export class EmptyDownload extends Error {
  constructor(url) {
    super('server returned an empty body');
    this.name = 'EmptyDownload';
    this.url = url;
  }
}

export class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME).reverse().map(([ext, type]) => [type, ext]));

export function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name ?? ''));
  return m ? m[1].toLowerCase() : '';
}

export function mimeOf(name, fallback = 'application/octet-stream') {
  return MIME[extOf(name)] ?? fallback;
}

/** video | audio | photo | animation | document */
export function kindOf(name, type = '') {
  const ext = extOf(name);
  if (['mp4', 'm4v', 'mov', 'webm', 'mkv'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'ogg', 'opus', 'wav', 'flac'].includes(ext)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'photo';
  if (ext === 'gif') return 'animation';
  const t = String(type).toLowerCase();
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'image/gif') return 'animation';
  if (t.startsWith('image/')) return 'photo';
  return 'document';
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Strips directories and control characters; keeps Unicode titles intact. */
export function safeFilename(name, fallback = 'download.bin') {
  if (!name) return fallback;
  let clean = safeDecode(String(name)).replace(/\\/g, '/');
  clean = clean.slice(clean.lastIndexOf('/') + 1);
  clean = clean.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, '_').replace(/^[\s._]+|[\s._]+$/g, '');
  if (!clean) return fallback;
  if (clean.length > 120) {
    const ext = extOf(clean);
    clean = ext ? `${clean.slice(0, 110)}.${ext}` : clean.slice(0, 120);
  }
  return clean;
}

export function nameFromHeaders(headers, url) {
  const disposition = headers?.get?.('content-disposition') ?? '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  if (star) return safeDecode(star[1].trim());
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition);
  if (plain) return plain[1].trim();
  const path = String(url ?? '').split(/[?#]/)[0];
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last && last.includes('.') ? safeDecode(last) : null;
}

function declaredSize(headers) {
  const exact = Number(headers?.get?.('content-length'));
  if (Number.isFinite(exact) && exact > 0) return { size: exact, exact: true };
  // Cobalt sends an estimate when it remuxes on the fly; good enough to refuse early.
  const estimate = Number(headers?.get?.('estimated-content-length'));
  if (Number.isFinite(estimate) && estimate > 0) return { size: estimate, exact: false };
  return { size: null, exact: false };
}

function toBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new TypeError('the response body is not binary');
}

/**
 * Downloads `url` into memory. Refuses as soon as the file is known to exceed
 * `limitBytes`. `onProgress(percent)` is called as data arrives, when the
 * size is known.
 */
export async function fetchFile(url, { limitBytes, fallbackName = 'download.bin', onProgress } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'cobalt-telegram-bot/2.0' } });
  if (!res.ok) throw new HttpError(res.status);

  const declared = declaredSize(res.headers);
  // An estimate can be a little off: only trust it when it is clearly over.
  if (declared.size && declared.size > (declared.exact ? limitBytes : limitBytes * 1.1)) {
    throw new FileTooLarge(declared.size, limitBytes);
  }

  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  let name = safeFilename(nameFromHeaders(res.headers, res.url || url) ?? fallbackName, fallbackName);
  if (!extOf(name)) name = `${name}.${EXT_BY_MIME[type] ?? (extOf(fallbackName) || 'bin')}`;

  // With an exact size the bytes go straight into place: one copy, not two.
  let buffer = declared.exact ? new Uint8Array(declared.size) : null;
  const chunks = [];
  let total = 0;
  let lastPercent = 0;
  let lastReport = Date.now();

  for await (const raw of res.body) {
    const chunk = toBytes(raw);
    if (total + chunk.byteLength > limitBytes) throw new FileTooLarge(declared.size, limitBytes);
    if (buffer && total + chunk.byteLength <= buffer.byteLength) buffer.set(chunk, total);
    else {
      if (buffer) {
        // The server sent more than it declared; fall back to collecting.
        chunks.push(buffer.subarray(0, total));
        buffer = null;
      }
      chunks.push(chunk);
    }
    total += chunk.byteLength;

    if (onProgress && declared.size) {
      // Every 10% and no more often than every 3 s: Telegram throttles edits.
      const percent = Math.min(99, Math.floor((total * 100) / declared.size));
      if (percent >= lastPercent + 10 && Date.now() - lastReport >= 3000) {
        lastPercent = percent;
        lastReport = Date.now();
        await onProgress(percent);
      }
    }
  }

  if (total === 0) throw new EmptyDownload(url);

  let bytes;
  if (buffer) bytes = total === buffer.byteLength ? buffer : buffer.subarray(0, total);
  else {
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
  }
  return { bytes, name, type: type || mimeOf(name), size: total };
}
