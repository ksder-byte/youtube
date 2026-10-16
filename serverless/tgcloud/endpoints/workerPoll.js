// pull mode: the worker on your PC calls this every few seconds. It reports
// the jobs it finished and takes new ones. The PC needs no address of its own.
//
// The worker signs the init data with the bot token (it is the same bot), so
// the platform lets the call in like any Mini App call; WORKER_SECRET is what
// tells it apart from a Mini App user.

import { EndpointError } from 'sdk';
import { config } from '../lib/config.js';
import { finishJobs, setState, takeJobs } from '../lib/store.js';

/** Compares without stopping at the first difference. */
function sameSecret(given, expected) {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default async function (input, ctx) {
  if (config.workerMode !== 'pull') {
    throw new EndpointError('Pull mode is off: WORKER_URL is set in secrets.js', { code: 'DISABLED' });
  }
  if (!sameSecret(input?.secret, config.workerSecret)) {
    console.warn(`workerPoll: wrong secret from user ${ctx?.initData?.user?.id}`);
    throw new EndpointError('Wrong WORKER_SECRET', { code: 'FORBIDDEN' });
  }

  const done = Array.isArray(input.done) ? input.done.filter(Number.isInteger).slice(0, 100) : [];
  if (done.length) await finishJobs(done);

  const info = input.info && typeof input.info === 'object' ? input.info : {};
  await setState('worker_seen', 'yes');
  await setState(
    'worker_info',
    JSON.stringify({ ytdlp: String(info.ytdlp ?? '').slice(0, 40), version: String(info.version ?? '').slice(0, 40) }),
  );

  const max = Math.max(0, Math.min(10, Number.isInteger(input.max) ? input.max : 1));
  const jobs = await takeJobs(max);
  return { jobs, pollAfter: jobs.length ? 0 : config.workerPollSeconds };
}
