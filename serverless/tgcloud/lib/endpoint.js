// Shared bits of the Mini App's endpoints.

import { EndpointError } from 'sdk';
import { config } from './config.js';
import { cleanUrl } from './links.js';
import { getLink, putLink } from './store.js';
import { isSubscribed } from './subscription.js';

/** The caller, as verified by the platform from the Mini App's init data. */
export function requireUser(ctx) {
  const user = ctx?.initData?.user;
  if (!user?.id) throw new EndpointError('Открой Mini App из Telegram', { code: 'NO_USER' });
  return user;
}

export async function requireSubscription(user) {
  if (!(await isSubscribed(user.id))) {
    throw new EndpointError('Чтобы скачивать, подпишись на канал', {
      code: 'NOT_SUBSCRIBED',
      url: config.requiredChannelUrl || null,
    });
  }
}

/** { url, token } from either a pasted link or a token from the chat's buttons. */
export async function linkFromInput(input, user) {
  if (input?.token) {
    const link = await getLink(String(input.token));
    // Tokens are not secrets, but a user's links are theirs.
    if (!link || link.userId !== user.id) throw new EndpointError('Ссылка устарела — вставь её ещё раз', { code: 'LINK_EXPIRED' });
    return { url: link.url, token: String(input.token) };
  }
  const url = cleanUrl(input?.url);
  if (!url) throw new EndpointError('Это не похоже на ссылку', { code: 'BAD_URL' });
  return { url, token: await putLink(url, user.id) };
}

/** Bot texts are HTML; the Mini App shows plain text. */
export function plain(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}
