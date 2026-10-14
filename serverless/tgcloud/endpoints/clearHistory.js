import { requireUser } from '../lib/endpoint.js';
import { clearHistory } from '../lib/store.js';

export default async function (input, ctx) {
  const user = requireUser(ctx);
  await clearHistory(user.id);
  return { items: [] };
}
