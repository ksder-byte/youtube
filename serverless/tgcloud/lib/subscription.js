// Optional forced subscription to a channel.

import { api, BotApiError } from 'sdk';
import { config } from './config.js';

const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);

export function subscriptionRequired() {
  return Boolean(config.requiredChannel);
}

export async function isSubscribed(userId) {
  if (!config.requiredChannel) return true;
  try {
    const member = await api.getChatMember({ chat_id: config.requiredChannel, user_id: userId });
    return MEMBER_STATUSES.has(member.status) || (member.status === 'restricted' && member.is_member === true);
  } catch (e) {
    if (e instanceof BotApiError && e.code === 400) {
      // Misconfiguration (the bot is not an admin of the channel, a wrong
      // @username…). Failing open keeps the bot usable instead of locking
      // everyone out.
      console.error(
        `Cannot verify subscription of ${userId} to ${config.requiredChannel}: ${e.description}. ` +
          'Make the bot an administrator of the channel.',
      );
      return true;
    }
    console.warn(`Subscription check failed for ${userId}: ${e.message}`);
    return false;
  }
}
