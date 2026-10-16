// Client for the download worker (app/worker.py, BOT_MODE=worker).
//
// The worker runs yt-dlp and ffmpeg, which a V8 sandbox cannot. It receives
// the id of a status message this bot already sent, edits it as it goes and
// sends the file to the chat itself, with the same bot token.
//
// Two ways to reach it:
//   push — POST to WORKER_URL (the worker has a public address);
//   pull — queue the job in the database; the worker polls endpoints/workerPoll
//          (a home PC with no address at all).

import { fetch } from 'sdk';
import { config } from './config.js';
import { enqueueJob, getState, queueLength } from './store.js';
import { describeError, now, withTimeout } from './util.js';

export function workerEnabled() {
  return config.worker;
}

function auth() {
  return { Authorization: `Bearer ${config.workerSecret}` };
}

/**
 * Hands a job over. Resolves to { ok: true } once the worker accepted it (or,
 * in pull mode, it is queued), or { ok: false, reason } with reason:
 * busy | overloaded | offline | rejected | unreachable.
 */
export async function submitJob({ chatId, messageId, userId, url, mode, quality, token, prefs }) {
  if (!config.worker) return { ok: false, reason: 'unreachable', detail: 'worker is not configured' };
  const body = {
    chat_id: chatId,
    message_id: messageId,
    user_id: userId,
    url,
    mode,
    quality: quality || '-',
    token: token || '',
    prefs: prefs
      ? {
          video_quality: prefs.videoQuality,
          audio_format: prefs.audioFormat,
          audio_bitrate: prefs.audioBitrate,
          youtube_video_codec: prefs.codec,
        }
      : {},
  };
  if (config.workerMode === 'pull') return enqueueJob(userId, body);

  let res;
  try {
    res = await withTimeout(
      fetch(`${config.workerUrl}/v1/jobs`, {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      20_000,
    );
  } catch (e) {
    console.error(`worker unreachable: ${describeError(e)}`);
    return { ok: false, reason: 'unreachable', detail: describeError(e) };
  }
  if (res.status === 202) return { ok: true };
  const detail = (await res.text().catch(() => '')).slice(0, 200);
  if (res.status === 409) return { ok: false, reason: 'busy', detail };
  if (res.status === 503) return { ok: false, reason: 'overloaded', detail };
  console.error(`worker refused the job: HTTP ${res.status} ${detail}`);
  return { ok: false, reason: res.status === 401 || res.status === 400 ? 'rejected' : 'unreachable', detail };
}

/** { ok, ytdlp, jobs, … } or { ok: false, error }; never throws. */
export async function workerHealth() {
  if (!config.worker) return { ok: false, error: 'not configured' };
  if (config.workerMode === 'pull') {
    const [seen, info, jobs] = await Promise.all([getState('worker_seen'), getState('worker_info'), queueLength()]);
    let details = {};
    try {
      details = JSON.parse(info?.value ?? '{}');
    } catch {}
    const ago = seen ? now() - seen.updated_at : null;
    const online = ago !== null && ago <= config.workerOfflineAfter;
    return { ...details, ok: online, pull: true, lastSeenAgo: ago, jobs, max_queue: config.workerMaxQueue, error: online ? undefined : 'offline' };
  }
  try {
    const res = await withTimeout(fetch(`${config.workerUrl}/healthz`, { headers: auth() }), 10_000);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}
