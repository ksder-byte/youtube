// Every incoming message: commands, links, everything else.

import * as commands from '../lib/commands.js';
import { actionsKb, subscribeKb } from '../lib/keyboards.js';
import { extractUrl } from '../lib/links.js';
import { getPrefs, putLink, touchUser } from '../lib/store.js';
import { isSubscribed } from '../lib/subscription.js';
import { parseCommand, say } from '../lib/telegram.js';
import * as texts from '../lib/texts.js';

const COMMAND_HANDLERS = {
  start: commands.start,
  help: commands.help,
  settings: commands.settings,
  status: commands.status,
  app: commands.app,
  setup: commands.setup,
};

export default async function (message) {
  const user = message.from;
  if (!user || user.is_bot) return;
  const text = message.text ?? message.caption ?? '';
  const isPrivate = message.chat.type === 'private';

  const command = text.startsWith('/') ? await parseCommand(text) : null;
  if (text.startsWith('/') && (!command || !COMMAND_HANDLERS[command.name])) return;

  const url = command ? null : extractUrl(message);
  // In groups the bot only speaks when spoken to: a command or a link.
  if (!command && !url && !isPrivate) return;

  await touchUser(user);

  if (!(await isSubscribed(user.id))) {
    await say(message.chat.id, texts.SUBSCRIBE_REQUIRED, { reply_markup: subscribeKb() });
    return;
  }

  if (command) {
    await COMMAND_HANDLERS[command.name](message, command.args);
    return;
  }

  if (!url) {
    await say(message.chat.id, texts.NOT_A_LINK);
    return;
  }

  const [token, prefs] = await Promise.all([putLink(url, user.id), getPrefs(user.id)]);
  await say(message.chat.id, texts.CHOOSE_ACTION, {
    reply_markup: actionsKb(token, prefs.videoQuality, isPrivate),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  });
}
