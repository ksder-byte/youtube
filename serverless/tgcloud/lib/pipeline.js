// The download pipeline: from a link to a file in the chat.
//
//   YouTube ──────────────────────────→ worker (yt-dlp + ffmpeg on your server)
//   everything else → Cobalt → ≤ 30 MB → sent from here
//                            → bigger, muxing, empty tunnel → worker, if there is one

import { BotApiError } from 'sdk';
import { CobaltError, CobaltUnavailable, STATUS, processUrl } from './cobalt.js';
import { UPLOAD_LIMIT_MB, config } from './config.js';
import { EmptyDownload, FileTooLarge, HttpError, fetchFile, kindOf, safeFilename } from './download.js';
import { fallbackKb, MODE_AUDIO } from './keyboards.js';
import { isYoutube } from './links.js';
import { sendAlbum, sendFile } from './send.js';
import { addHistory, updateHistory } from './store.js';
import { edit, remove } from './telegram.js';
import * as texts from './texts.js';
import { TimeoutError, mb } from './util.js';
import { submitJob } from './worker.js';

export const MAX_PICKER_ITEMS = 20;
// Keep an album request well under the Bot API's per-request size.
const ALBUM_BYTES = 45 * 1024 * 1024;

/** worker | cobalt | none */
export function chooseRoute(url) {
  const hasCobalt = config.cobaltInstances.length > 0;
  if (config.worker && (!hasCobalt || (config.youtubeViaWorker && isYoutube(url)))) return 'worker';
  return hasCobalt ? 'cobalt' : 'none';
}

function inlineLimitBytes() {
  return config.inlineLimitMb * 1024 * 1024;
}

/**
 * Runs one download. `job`: { chatId, messageId (the status message), userId,
 * url, mode: 'v'|'a', quality: '720'|'-'…, token, prefs, via: 'bot'|'app',
 * isPrivate }. Resolves to { status, … }; never throws for an expected failure.
 */
export async function runJob(job) {
  const quality = job.quality && job.quality !== '-' ? job.quality : job.prefs.videoQuality;
  const historyId = await addHistory({
    userId: job.userId,
    url: job.url,
    mode: job.mode,
    quality: job.mode === MODE_AUDIO ? null : quality,
    via: job.via ?? 'bot',
  });
  const ctx = { ...job, quality, historyId };

  try {
    const route = chooseRoute(job.url);
    if (route === 'none') return await fail(ctx, texts.NOT_CONFIGURED, 'not configured');
    if (route === 'worker') return await handOff(ctx, texts.HANDING_OFF);
    return await viaCobalt(ctx);
  } catch (e) {
    if (e instanceof TimeoutError) return fail(ctx, texts.TIMEOUT, e.message);
    console.error('job failed', job.url, e);
    return fail(ctx, texts.UNKNOWN_ERROR(String(e?.description ?? e?.message ?? e).slice(0, 300)), String(e?.message ?? e));
  }
}

async function status(ctx, text, markup = null) {
  await edit(ctx.chatId, ctx.messageId, text, markup);
}

async function fail(ctx, text, error, markup = null, historyStatus = 'error') {
  await status(ctx, text, markup);
  await updateHistory(ctx.historyId, { status: historyStatus, error: String(error).slice(0, 300) });
  return { status: historyStatus, error };
}

async function handOff(ctx, note) {
  await status(ctx, note);
  const result = await submitJob({
    chatId: ctx.chatId,
    messageId: ctx.messageId,
    userId: ctx.userId,
    url: ctx.url,
    mode: ctx.mode,
    quality: ctx.mode === MODE_AUDIO ? '-' : ctx.quality,
    token: ctx.token,
    prefs: ctx.prefs,
  });
  if (result.ok) {
    await updateHistory(ctx.historyId, { status: 'worker' });
    return { status: 'worker' };
  }
  const text = { busy: texts.WORKER_BUSY, overloaded: texts.WORKER_OVERLOADED }[result.reason] ?? texts.WORKER_UNAVAILABLE;
  return fail(ctx, text, `worker: ${result.reason} ${result.detail ?? ''}`.trim());
}

async function viaCobalt(ctx) {
  await status(ctx, texts.FETCHING);
  let result;
  try {
    result = await processUrl(ctx.url, { mode: ctx.mode, quality: ctx.quality, prefs: ctx.prefs });
  } catch (e) {
    if (e instanceof CobaltError) return fail(ctx, texts.cobaltError(e.code), e.code);
    if (e instanceof CobaltUnavailable || e instanceof TimeoutError) {
      console.error('Cobalt unavailable:', e.message);
      if (config.worker) return handOff(ctx, texts.HANDING_OFF);
      return fail(ctx, texts.COBALT_ERRORS['error.api.unreachable'], e.message);
    }
    throw e;
  }

  if (result.status === STATUS.PICKER) return sendPicker(ctx, result);

  if (result.status === STATUS.LOCAL_PROCESSING) {
    // Separate tracks to be muxed: that takes ffmpeg.
    if (config.worker) return handOff(ctx, texts.HANDING_OFF);
    if (result.tunnels.length !== 1) return fail(ctx, texts.LOCAL_PROCESSING, 'local-processing');
    result = { status: STATUS.TUNNEL, url: result.tunnels[0], filename: result.filename };
  }

  if (!result.url) return fail(ctx, texts.UNKNOWN_ERROR('Cobalt не вернул ссылку'), 'no url');

  const audio = ctx.mode === MODE_AUDIO;
  let file;
  try {
    await status(ctx, texts.DOWNLOADING);
    file = await fetchFile(result.url, {
      limitBytes: inlineLimitBytes(),
      fallbackName: safeFilename(result.filename, audio ? 'audio.mp3' : 'video.mp4'),
      onProgress: (percent) => status(ctx, texts.downloadingProgress(percent)),
    });
  } catch (e) {
    if (e instanceof FileTooLarge) {
      const fits = !e.sizeBytes || e.sizeBytes <= UPLOAD_LIMIT_MB * 1024 * 1024;
      if (config.worker && fits) return handOff(ctx, texts.HANDING_OFF_LARGE);
      return tooLarge(ctx, e.sizeBytes, result.url);
    }
    if (e instanceof EmptyDownload) {
      if (config.worker) return handOff(ctx, texts.HANDING_OFF);
      return fail(ctx, texts.EMPTY_FILE, 'empty tunnel');
    }
    if (e instanceof HttpError) return fail(ctx, texts.UNKNOWN_ERROR(`источник ответил ${e.message}`), e.message);
    throw e;
  }

  await status(ctx, texts.UPLOADING);
  try {
    await sendFile(ctx.chatId, file, { forceAudio: audio });
  } catch (e) {
    if (e instanceof BotApiError && e.code === 413) return tooLarge(ctx, file.size, result.url);
    throw e;
  }
  await remove(ctx.chatId, ctx.messageId);
  await updateHistory(ctx.historyId, { status: 'sent', title: file.name, sizeBytes: file.size });
  return { status: 'sent', name: file.name, size: file.size };
}

async function tooLarge(ctx, sizeBytes, directUrl) {
  const limit = config.worker ? UPLOAD_LIMIT_MB : config.inlineLimitMb;
  const markup = fallbackKb(ctx.token, ctx.quality, { directUrl, isPrivate: ctx.isPrivate !== false });
  await status(ctx, texts.tooLarge(sizeBytes ? mb(sizeBytes) : null, limit), markup);
  await updateHistory(ctx.historyId, { status: 'too_large', sizeBytes: sizeBytes ?? null });
  return { status: 'too_large', sizeBytes, directUrl };
}

const PICKER_EXT = { photo: 'jpg', video: 'mp4', gif: 'gif' };

async function sendPicker(ctx, result) {
  const items = result.picker.slice(0, MAX_PICKER_ITEMS);
  await status(ctx, `⬇️ Скачиваю ${items.length} файл(ов)...`);

  const limitBytes = inlineLimitBytes();
  let album = [];
  let albumBytes = 0;
  let skipped = 0;
  let sent = 0;

  const flush = async () => {
    if (!album.length) return;
    await sendAlbum(ctx.chatId, album);
    sent += album.length;
    album = [];
    albumBytes = 0;
  };

  // Files go out as soon as an album fills up, so memory holds one album at most.
  for (const [index, item] of items.entries()) {
    let file;
    try {
      file = await fetchFile(item.url, {
        limitBytes,
        fallbackName: `media_${index + 1}.${PICKER_EXT[item.type] ?? 'bin'}`,
      });
    } catch (e) {
      if (e instanceof FileTooLarge || e instanceof EmptyDownload || e instanceof HttpError) {
        skipped++;
        continue;
      }
      throw e;
    }
    if (item.type === 'gif' || kindOf(file.name, file.type) === 'animation') {
      await sendFile(ctx.chatId, file);
      sent++;
      continue;
    }
    if (album.length === 10 || albumBytes + file.size > ALBUM_BYTES) await flush();
    album.push(file);
    albumBytes += file.size;
  }
  await flush();

  if (result.audio) {
    try {
      const track = await fetchFile(result.audio, {
        limitBytes,
        fallbackName: safeFilename(result.audioFilename, 'audio.mp3'),
      });
      await sendFile(ctx.chatId, track, { forceAudio: true });
      sent++;
    } catch (e) {
      if (!(e instanceof FileTooLarge || e instanceof EmptyDownload || e instanceof HttpError)) throw e;
      skipped++;
    }
  }

  if (skipped) await status(ctx, texts.pickerSkipped(skipped));
  else if (!sent) await status(ctx, texts.cobaltError('error.api.fetch.empty'));
  else await remove(ctx.chatId, ctx.messageId);
  await updateHistory(ctx.historyId, {
    status: sent ? 'sent' : 'error',
    title: `${sent} файл(ов)`,
    error: skipped ? `${skipped} skipped` : null,
  });
  return { status: sent ? 'sent' : 'error', sent, skipped };
}
