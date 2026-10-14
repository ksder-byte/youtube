// "Send to chat" from the Mini App: the same pipeline as the bot's buttons,
// with the file landing in the user's private chat with the bot.

import { BotApiError, EndpointError } from 'sdk';
import { VIDEO_QUALITIES } from '../lib/config.js';
import { linkFromInput, plain, requireSubscription, requireUser } from '../lib/endpoint.js';
import { MODE_AUDIO, MODE_VIDEO } from '../lib/keyboards.js';
import { runJob } from '../lib/pipeline.js';
import { acquireJob, getPrefs, releaseJob } from '../lib/store.js';
import { say } from '../lib/telegram.js';
import * as texts from '../lib/texts.js';

export default async function (input, ctx) {
  const user = requireUser(ctx);
  await requireSubscription(user);
  const { url, token } = await linkFromInput(input, user);
  const mode = input?.mode === MODE_AUDIO ? MODE_AUDIO : MODE_VIDEO;
  const prefs = await getPrefs(user.id);
  const quality = mode === MODE_AUDIO ? '-' : VIDEO_QUALITIES.includes(input?.quality) ? input.quality : prefs.videoQuality;

  if (!(await acquireJob(user.id))) throw new EndpointError(plain(texts.BUSY), { code: 'BUSY' });
  try {
    let status;
    try {
      status = await say(user.id, texts.QUEUED);
    } catch (e) {
      // 403: the user never started the bot, or blocked it.
      if (e instanceof BotApiError && (e.code === 403 || e.code === 400)) {
        throw new EndpointError('Сначала открой чат с ботом и нажми «Старт»', { code: 'START_BOT' });
      }
      throw e;
    }

    const result = await runJob({
      chatId: user.id,
      messageId: status.message_id,
      userId: user.id,
      url,
      mode,
      quality,
      token,
      prefs,
      via: 'app',
      isPrivate: true,
    });
    return { status: result.status, token };
  } finally {
    await releaseJob(user.id);
  }
}
