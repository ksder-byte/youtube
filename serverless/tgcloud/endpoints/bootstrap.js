// First call of the Mini App: who the user is, their settings, what the bot can do.

import { AUDIO_BITRATES, AUDIO_FORMATS, UPLOAD_LIMIT_MB, VIDEO_QUALITIES, YOUTUBE_CODECS, config } from '../lib/config.js';
import { requireUser } from '../lib/endpoint.js';
import { getLink, getPrefs, touchUser } from '../lib/store.js';
import { isSubscribed, subscriptionRequired } from '../lib/subscription.js';

export default async function (input, ctx) {
  const user = requireUser(ctx);
  await touchUser(user);
  const [prefs, subscribed] = await Promise.all([getPrefs(user.id), isSubscribed(user.id)]);

  // Opened from a link's "Mini App" button: hand the link over to prefill.
  let link = null;
  const token = input?.token ?? ctx.initData.start_param ?? null;
  if (token) {
    const found = await getLink(String(token));
    if (found && found.userId === user.id) link = { url: found.url, token: String(token) };
  }

  return {
    user: { id: user.id, firstName: user.first_name ?? '' },
    subscription: {
      required: subscriptionRequired(),
      ok: subscribed,
      url: config.requiredChannelUrl || null,
    },
    prefs,
    defaults: config.defaults,
    options: {
      qualities: VIDEO_QUALITIES.filter((q) => Number(q) >= 360 || q === 'max'),
      audioFormats: AUDIO_FORMATS,
      audioBitrates: AUDIO_BITRATES.filter((b) => b !== '8'),
      codecs: YOUTUBE_CODECS,
    },
    features: {
      cobalt: config.cobaltInstances.length > 0,
      worker: config.worker,
      inlineLimitMb: config.inlineLimitMb,
      uploadLimitMb: config.worker ? UPLOAD_LIMIT_MB : config.inlineLimitMb,
    },
    link,
  };
}
