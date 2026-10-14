// The user's recent downloads, newest first.

import { requireUser } from '../lib/endpoint.js';
import { hostOf } from '../lib/links.js';
import { listHistory } from '../lib/store.js';

export default async function (input, ctx) {
  const user = requireUser(ctx);
  const items = await listHistory(user.id, 30);
  return { items: items.map((item) => ({ ...item, host: hostOf(item.url) })) };
}
