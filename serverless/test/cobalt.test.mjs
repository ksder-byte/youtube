import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { CobaltError, CobaltUnavailable, processUrl, survey } from '../tgcloud/lib/cobalt.js';
import { config } from '../tgcloud/lib/config.js';
import { unhealthyInstances } from '../tgcloud/lib/store.js';
import { fresh, json, serve } from './helpers.mjs';

const servers = [];
async function cobalt(handler) {
  const s = await serve({ 'POST /': (req, res, body) => handler(res, JSON.parse(body), req), 'GET /': (req, res) => json(res, 200, { cobalt: { version: '11.7.1', services: ['youtube', 'tiktok'] } }) });
  servers.push(s);
  return s;
}

beforeEach(() => fresh());
afterEach(async () => {
  while (servers.length) await servers.pop().close();
});

test('sends the right payload and API key', async () => {
  const a = await cobalt((res) => json(res, 200, { status: 'tunnel', url: 'http://t/1', filename: 'a.mp3' }));
  await fresh({ COBALT_INSTANCES: [`${a.base}|secret-key`] });
  const result = await processUrl('https://youtu.be/x', { mode: 'a', quality: '-', prefs: { ...config.defaults, audioFormat: 'opus' } });
  assert.equal(result.status, 'tunnel');
  assert.equal(result.filename, 'a.mp3');
  const hit = a.hits[0];
  assert.equal(hit.headers.authorization, 'Api-Key secret-key');
  const payload = JSON.parse(hit.body);
  assert.equal(payload.downloadMode, 'audio');
  assert.equal(payload.audioFormat, 'opus');
  assert.equal(payload.videoQuality, '1080');
  assert.equal(payload.localProcessing, 'disabled');
});

test('fails over to the next instance and remembers the broken one', async () => {
  const broken = await cobalt((res) => json(res, 502, { status: 'error', error: { code: 'error.api.generic' } }));
  const good = await cobalt((res) => json(res, 200, { status: 'redirect', url: 'https://cdn/x.mp4', filename: 'x.mp4' }));
  await fresh({ COBALT_INSTANCES: [broken.base, good.base] });

  const result = await processUrl('https://tiktok.com/@a/video/1');
  assert.equal(result.status, 'redirect');
  assert.equal(result.source, good.base.replace('http://', ''));
  assert.ok((await unhealthyInstances()).has(broken.base));

  // Next time the healthy one goes first.
  await processUrl('https://tiktok.com/@a/video/2');
  assert.equal(broken.hits.length, 1);
  assert.equal(good.hits.length, 2);
});

test('a definite answer about the link is not retried elsewhere', async () => {
  const a = await cobalt((res) => json(res, 400, { status: 'error', error: { code: 'error.api.content.video.private' } }));
  const b = await cobalt((res) => json(res, 200, { status: 'tunnel', url: 'http://t' }));
  await fresh({ COBALT_INSTANCES: [a.base, b.base] });
  await assert.rejects(processUrl('https://youtu.be/x'), (e) => e instanceof CobaltError && e.code === 'error.api.content.video.private');
  assert.equal(b.hits.length, 0);
});

test('an instance-specific refusal moves on; the last one is reported', async () => {
  const a = await cobalt((res) => json(res, 400, { status: 'error', error: { code: 'error.api.auth.jwt.missing' } }));
  const b = await cobalt((res) => json(res, 400, { status: 'error', error: { code: 'error.api.youtube.no_session_tokens' } }));
  await fresh({ COBALT_INSTANCES: [a.base, b.base] });
  await assert.rejects(processUrl('https://youtu.be/x'), (e) => e.code === 'error.api.youtube.no_session_tokens');
  assert.ok((await unhealthyInstances()).has(a.base), 'auth errors cool the instance down');
});

test('a rate limit on a public instance is reported as such', async () => {
  const limited = await cobalt((res) => json(res, 429, { status: 'error', error: { code: 'error.api.rate_exceeded', context: { limit: 60 } } }));
  await fresh({ COBALT_INSTANCES: [limited.base] });
  await assert.rejects(processUrl('https://tiktok.com/@a/video/1'), (e) => e instanceof CobaltError && e.code === 'error.api.rate_exceeded');
  assert.equal(limited.hits.length, 1, 'no hammering a rate-limited instance');
});

test('nothing answers: CobaltUnavailable', async () => {
  const html = await cobalt((res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>'));
  await fresh({ COBALT_INSTANCES: [html.base, 'http://127.0.0.1:9'] });
  await assert.rejects(processUrl('https://x.com/a'), CobaltUnavailable);
  await fresh({ COBALT_INSTANCES: [] });
  await assert.rejects(processUrl('https://x.com/a'), CobaltUnavailable);
});

test('a single instance gets a second try', async () => {
  let n = 0;
  const flaky = await serve({
    'POST /': (req, res) => {
      n++;
      if (n === 1) req.socket.destroy();
      else json(res, 200, { status: 'tunnel', url: 'http://t' });
    },
  });
  servers.push(flaky);
  await fresh({ COBALT_INSTANCES: [flaky.base] });
  assert.equal((await processUrl('https://x.com/a')).status, 'tunnel');
  assert.equal(n, 2);
});

test('picker and local-processing parsing', async () => {
  const a = await cobalt((res, body) =>
    body.url.includes('insta')
      ? json(res, 200, { status: 'picker', picker: [{ type: 'photo', url: 'http://p/1' }, { type: 'video' }], audio: 'http://a' })
      : json(res, 200, { status: 'local-processing', type: 'merge', tunnel: ['http://v', 'http://a'], output: { filename: 'x.mp4' }, audio: { copy: true } }),
  );
  await fresh({ COBALT_INSTANCES: [a.base] });
  const picker = await processUrl('https://instagram.com/p/1');
  assert.equal(picker.picker.length, 1, 'items without a url are dropped');
  assert.equal(picker.audio, 'http://a');
  const local = await processUrl('https://youtu.be/x');
  assert.deepEqual(local.tunnels, ['http://v', 'http://a']);
  assert.equal(local.filename, 'x.mp4');
});

test('survey explains what each instance is', async () => {
  const good = await cobalt(() => {});
  const site = await serve({ '/': (req, res) => res.writeHead(200).end('<html>cobalt</html>') });
  servers.push(site);
  await fresh({ COBALT_INSTANCES: [good.base, site.base] });
  const [a, b] = await survey();
  assert.equal(a.ok, true);
  assert.equal(a.youtube, true);
  assert.equal(b.ok, false);
  assert.match(b.error, /HTML/);
});
