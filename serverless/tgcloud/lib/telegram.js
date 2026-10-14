// Bot API calls the bot makes all the time, with the failures that do not matter swallowed.

import { api, BotApiError } from 'sdk';
import { sleep } from './util.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

export function say(chatId, text, extra = {}) {
  return api.sendMessage({ chat_id: chatId, text, ...HTML, ...extra });
}

function retryAfter(e) {
  return e instanceof BotApiError && e.code === 429 ? Number(e.parameters?.retry_after ?? 1) : 0;
}

/**
 * Edits a status message. Progress updates are cosmetic: a failed edit never
 * kills a job. `markup` null removes the keyboard.
 */
export async function edit(chatId, messageId, text, markup = null) {
  const params = {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...HTML,
    reply_markup: markup ?? { inline_keyboard: [] },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await api.editMessageText(params);
      return true;
    } catch (e) {
      const wait = retryAfter(e);
      if (wait && attempt === 0 && wait <= 10) {
        await sleep(wait * 1000);
        continue;
      }
      // 400: "message is not modified", or it is gone — both fine here.
      if (e instanceof BotApiError && (e.code === 400 || e.code === 429)) return false;
      throw e;
    }
  }
  return false;
}

export async function remove(chatId, messageId) {
  try {
    await api.deleteMessage({ chat_id: chatId, message_id: messageId });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
  }
}

export async function answer(callbackQueryId, text, alert = false) {
  try {
    await api.answerCallbackQuery({ callback_query_id: callbackQueryId, text, show_alert: alert });
  } catch (e) {
    // Too old to answer (the user waited > 15 min): nothing to do about it.
    if (!(e instanceof BotApiError)) throw e;
  }
}

/** Runs a Bot API call once more after a 429, if the wait is short. */
export async function withRetry(call) {
  try {
    return await call();
  } catch (e) {
    const wait = retryAfter(e);
    if (!wait || wait > 30) throw e;
    await sleep(wait * 1000);
    return call();
  }
}

let me = null;

/** getMe, cached for the life of the isolate. */
export async function botInfo() {
  if (!me) me = await api.getMe();
  return me;
}

/** '/start@bot payload' -> { name: 'start', args: 'payload' }, or null if not ours. */
export async function parseCommand(text) {
  const m = /^\/([a-z0-9_]{1,32})(?:@([a-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  if (m[2]) {
    const { username } = await botInfo();
    if (username && m[2].toLowerCase() !== username.toLowerCase()) return null;
  }
  return { name: m[1].toLowerCase(), args: (m[3] ?? '').trim() };
}
