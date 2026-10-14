// Saves the user's defaults; the bot's buttons use the same ones.

import { EndpointError } from 'sdk';
import { requireUser } from '../lib/endpoint.js';
import { savePrefs } from '../lib/store.js';

const KEYS = ['videoQuality', 'audioFormat', 'audioBitrate', 'codec'];

export default async function (input, ctx) {
  const user = requireUser(ctx);
  const changes = {};
  for (const key of KEYS) if (input?.[key] != null) changes[key] = String(input[key]);
  try {
    return { prefs: await savePrefs(user.id, changes) };
  } catch (e) {
    if (e instanceof RangeError) throw new EndpointError('Недопустимое значение', { code: 'BAD_VALUE' });
    throw e;
  }
}
