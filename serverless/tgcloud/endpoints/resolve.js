// Asks Cobalt about a link and returns direct file links for the Mini App,
// which downloads them to the device: no 50 MB Bot API limit on that path.

import { EndpointError } from 'sdk';
import { CobaltError, CobaltUnavailable, STATUS, processUrl } from '../lib/cobalt.js';
import { VIDEO_QUALITIES, config } from '../lib/config.js';
import { kindOf, safeFilename } from '../lib/download.js';
import { linkFromInput, plain, requireSubscription, requireUser } from '../lib/endpoint.js';
import { MODE_AUDIO, MODE_VIDEO } from '../lib/keyboards.js';
import { hostOf } from '../lib/links.js';
import { chooseRoute } from '../lib/pipeline.js';
import { addHistory, getPrefs, recentRequests, updateHistory } from '../lib/store.js';
import * as texts from '../lib/texts.js';
import { TimeoutError } from '../lib/util.js';

const PER_MINUTE = 20;

export default async function (input, ctx) {
  const user = requireUser(ctx);
  await requireSubscription(user);
  if ((await recentRequests(user.id, 60)) >= PER_MINUTE) {
    throw new EndpointError('Слишком много запросов. Подожди минуту.', { code: 'RATE_LIMITED' });
  }

  const { url, token } = await linkFromInput(input, user);
  const mode = input?.mode === MODE_AUDIO ? MODE_AUDIO : MODE_VIDEO;
  const prefs = await getPrefs(user.id);
  const quality = VIDEO_QUALITIES.includes(input?.quality) ? input.quality : prefs.videoQuality;
  const base = { url, token, mode, quality, host: hostOf(url) };

  const route = chooseRoute(url);
  if (route === 'none') throw new EndpointError(plain(texts.NOT_CONFIGURED), { code: 'NOT_CONFIGURED' });
  // YouTube is yt-dlp's job on the server: it can only send the file to the chat.
  if (route === 'worker') return { ...base, status: 'worker' };

  const historyId = await addHistory({ userId: user.id, url, mode, quality: mode === MODE_AUDIO ? null : quality, status: 'link', via: 'app' });
  let result;
  try {
    result = await processUrl(url, { mode, quality, prefs });
  } catch (e) {
    if (e instanceof CobaltError) {
      await updateHistory(historyId, { status: 'error', error: e.code });
      throw new EndpointError(plain(texts.cobaltError(e.code)), { code: e.code });
    }
    if (e instanceof CobaltUnavailable || e instanceof TimeoutError) {
      if (config.worker) return { ...base, status: 'worker' };
      await updateHistory(historyId, { status: 'error', error: e.message });
      throw new EndpointError(plain(texts.COBALT_ERRORS['error.api.unreachable']), { code: 'UNREACHABLE' });
    }
    throw e;
  }

  if (result.status === STATUS.PICKER) {
    await updateHistory(historyId, { title: `${result.picker.length} файл(ов)` });
    return {
      ...base,
      status: 'picker',
      items: result.picker.slice(0, 50).map((item, i) => ({
        type: item.type,
        url: item.url,
        thumb: item.thumb,
        filename: `${hostOf(url) || 'media'}_${i + 1}.${{ photo: 'jpg', video: 'mp4', gif: 'gif' }[item.type] ?? 'bin'}`,
      })),
      audio: result.audio ? { url: result.audio, filename: safeFilename(result.audioFilename, 'audio.mp3') } : null,
    };
  }

  if (result.status === STATUS.LOCAL_PROCESSING) {
    if (config.worker) return { ...base, status: 'worker' };
    if (result.tunnels.length !== 1) {
      await updateHistory(historyId, { status: 'error', error: 'local-processing' });
      throw new EndpointError(plain(texts.LOCAL_PROCESSING), { code: 'LOCAL_PROCESSING' });
    }
    result = { url: result.tunnels[0], filename: result.filename };
  }

  const filename = safeFilename(result.filename, mode === MODE_AUDIO ? 'audio.mp3' : 'video.mp4');
  await updateHistory(historyId, { title: filename });
  return { ...base, status: 'file', file: { url: result.url, filename, kind: mode === MODE_AUDIO ? 'audio' : kindOf(filename) } };
}
