// Button presses: quality menu, downloads, settings, the subscription check.

import { settingsText } from '../lib/commands.js';
import { MODE_AUDIO, qualityKb, settingsKb, unpackDownload } from '../lib/keyboards.js';
import { runJob } from '../lib/pipeline.js';
import { acquireJob, getLink, getPrefs, releaseJob, savePrefs } from '../lib/store.js';
import { isSubscribed } from '../lib/subscription.js';
import { answer, edit } from '../lib/telegram.js';
import * as texts from '../lib/texts.js';

const SETTING_KEYS = { q: 'videoQuality', a: 'audioFormat' };

export default async function (query) {
  const data = query.data ?? '';
  const message = query.message;
  // date 0: the message is too old for the bot to edit (InaccessibleMessage).
  const usable = message && message.date !== 0;

  if (data === 'sub:check') {
    if (await isSubscribed(query.from.id)) {
      if (usable) await edit(message.chat.id, message.message_id, texts.SUBSCRIBE_OK);
      await answer(query.id);
    } else {
      await answer(query.id, texts.SUBSCRIBE_MISSING, true);
    }
    return;
  }

  if (!usable) {
    await answer(query.id, texts.LINK_EXPIRED, true);
    return;
  }
  const chatId = message.chat.id;

  if (data.startsWith('q:')) {
    await edit(chatId, message.message_id, texts.CHOOSE_QUALITY, qualityKb(data.slice(2)));
    await answer(query.id);
    return;
  }

  if (data.startsWith('set:')) {
    const [, key, value] = data.split(':');
    if (!SETTING_KEYS[key]) return answer(query.id);
    let prefs;
    try {
      prefs = await savePrefs(query.from.id, { [SETTING_KEYS[key]]: value });
    } catch {
      return answer(query.id);
    }
    await edit(chatId, message.message_id, settingsText(prefs), settingsKb(prefs, message.chat.type === 'private'));
    await answer(query.id, texts.SAVED);
    return;
  }

  const payload = unpackDownload(data);
  if (!payload) {
    await answer(query.id);
    return;
  }

  const link = await getLink(payload.token);
  if (!link) {
    await answer(query.id, texts.LINK_EXPIRED, true);
    return;
  }

  const userId = query.from.id;
  if (!(await acquireJob(userId))) {
    await answer(query.id, texts.BUSY, true);
    return;
  }

  try {
    await answer(query.id);
    // The message with the buttons becomes the job's status message.
    await edit(chatId, message.message_id, texts.QUEUED);
    await runJob({
      chatId,
      messageId: message.message_id,
      userId,
      url: link.url,
      mode: payload.mode,
      quality: payload.mode === MODE_AUDIO ? '-' : payload.quality,
      token: payload.token,
      prefs: await getPrefs(userId),
      via: 'bot',
      isPrivate: message.chat.type === 'private',
    });
  } finally {
    await releaseJob(userId);
  }
}
