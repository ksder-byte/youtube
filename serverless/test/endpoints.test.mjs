// The Mini App's endpoints, called the way the platform calls them.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import bootstrap from '../tgcloud/endpoints/bootstrap.js';
import clearHistoryEndpoint from '../tgcloud/endpoints/clearHistory.js';
import history from '../tgcloud/endpoints/history.js';
import resolve from '../tgcloud/endpoints/resolve.js';
import saveSettings from '../tgcloud/endpoints/saveSettings.js';
import send from '../tgcloud/endpoints/send.js';
import { acquireJob, putLink } from '../tgcloud/lib/store.js';
import { EndpointError } from './sdk/index.mjs';
import { BotApiError, bytes, callsOf, file, fresh, json, onApi, serve } from './helpers.mjs';

const ctx = (extra = {}) => ({ initData: { user: { id: 42, first_name: 'Ann' }, auth_date: 1, ...extra } });
const refused = (code) => (e) => e instanceof EndpointError && e.parameters.code === code;

let cobalt;
let answer;

beforeEach(async () => {
  answer = null;
  cobalt = await serve({
    'POST /': (req, res, body) => json(res, 200, answer ?? { status: 'tunnel', url: `${cobalt.base}/tunnel/clip`, filename: 'Clip (720p).mp4' }),
    '/tunnel/clip': (req, res) => file(res, bytes(1500), { name: 'Clip (720p).mp4' }),
  });
  await fresh({ COBALT_INSTANCES: [cobalt.base] });
});

afterEach(() => cobalt.close());

test('bootstrap: user, prefs, options, and the link from start_param', async () => {
  const token = await putLink('https://youtu.be/x', 42);
  const data = await bootstrap({}, ctx({ start_param: token }));
  assert.equal(data.user.id, 42);
  assert.equal(data.prefs.videoQuality, '1080');
  assert.deepEqual(data.link, { url: 'https://youtu.be/x', token });
  assert.ok(data.options.qualities.includes('max'));
  assert.equal(data.features.cobalt, true);
  assert.equal(data.features.uploadLimitMb, 30);
  assert.equal(data.subscription.ok, true);

  // Someone else's token is not handed over.
  const other = await putLink('https://youtu.be/secret', 7);
  assert.equal((await bootstrap({ token: other }, ctx())).link, null);
});

test('no verified user, no service', async () => {
  await assert.rejects(bootstrap({}, { initData: {} }), refused('NO_USER'));
});

test('resolve: a direct file link for the device', async () => {
  const data = await resolve({ url: 'https://www.tiktok.com/@a/video/1', mode: 'v', quality: '720' }, ctx());
  assert.equal(data.status, 'file');
  assert.equal(data.file.url, `${cobalt.base}/tunnel/clip`);
  assert.equal(data.file.filename, 'Clip (720p).mp4');
  assert.equal(data.file.kind, 'video');
  assert.equal(data.host, 'tiktok.com');
  assert.ok(data.token);
  const [h] = (await history({}, ctx())).items;
  assert.equal(h.status, 'link');
  assert.equal(h.via, 'app');
  assert.equal(h.title, 'Clip (720p).mp4');
});

test('resolve: picker items and errors', async () => {
  answer = { status: 'picker', picker: [{ type: 'photo', url: 'https://cdn/1.jpg', thumb: 'https://cdn/1t.jpg' }], audio: 'https://cdn/a.mp3' };
  const data = await resolve({ url: 'https://instagram.com/p/1' }, ctx());
  assert.equal(data.status, 'picker');
  assert.equal(data.items[0].filename, 'instagram.com_1.jpg');
  assert.equal(data.audio.url, 'https://cdn/a.mp3');

  answer = { status: 'error', error: { code: 'error.api.content.post.private' } };
  await assert.rejects(resolve({ url: 'https://instagram.com/p/2' }, ctx()), (e) => refused('error.api.content.post.private')(e) && !/</.test(e.message));
  await assert.rejects(resolve({ url: 'not a link' }, ctx()), refused('BAD_URL'));
});

test('resolve: YouTube with a worker can only be sent to the chat', async () => {
  await fresh({ COBALT_INSTANCES: [cobalt.base], WORKER_URL: 'https://w/worker', WORKER_SECRET: 's'.repeat(40) });
  const data = await resolve({ url: 'https://youtu.be/x', mode: 'a' }, ctx());
  assert.equal(data.status, 'worker');
  assert.equal(data.mode, 'a');
  assert.equal(cobalt.hits.length, 0);
});

test('resolve: only your own tokens, and a rate limit', async () => {
  const theirs = await putLink('https://youtu.be/x', 7);
  await assert.rejects(resolve({ token: theirs }, ctx()), refused('LINK_EXPIRED'));
  for (let i = 0; i < 20; i++) await resolve({ url: `https://vk.com/clip-${i}` }, ctx());
  await assert.rejects(resolve({ url: 'https://vk.com/clip-x' }, ctx()), refused('RATE_LIMITED'));
});

test('resolve and send need the subscription', async () => {
  await fresh({ COBALT_INSTANCES: [cobalt.base], REQUIRED_CHANNEL: '@chan', REQUIRED_CHANNEL_URL: 'https://t.me/chan' });
  onApi('getChatMember', () => ({ status: 'left' }));
  await assert.rejects(resolve({ url: 'https://vk.com/clip-1' }, ctx()), (e) => refused('NOT_SUBSCRIBED')(e) && e.parameters.url === 'https://t.me/chan');
  await assert.rejects(send({ url: 'https://vk.com/clip-1' }, ctx()), refused('NOT_SUBSCRIBED'));
  assert.equal((await bootstrap({}, ctx())).subscription.ok, false);
});

test('send: the file lands in the private chat', async () => {
  const data = await send({ url: 'https://www.tiktok.com/@a/video/1', mode: 'v', quality: '480' }, ctx());
  assert.equal(data.status, 'sent');
  const [status] = callsOf('sendMessage');
  assert.equal(status.chat_id, 42);
  const [video] = callsOf('sendVideo');
  assert.equal(video.chat_id, 42);
  assert.equal(video.video.bytes.length, 1500);
  assert.equal(callsOf('deleteMessage')[0].message_id, 100, 'the status message it sent');
  assert.equal(await acquireJob(42), true, 'lock released');
});

test('send: asks to start the bot first; busy while another job runs', async () => {
  onApi('sendMessage', () => {
    throw new BotApiError('sendMessage', 403, 'Forbidden: bot was blocked by the user');
  });
  await assert.rejects(send({ url: 'https://vk.com/clip-1' }, ctx()), refused('START_BOT'));
  assert.equal(await acquireJob(42), true, 'lock released after the refusal');
  await assert.rejects(send({ url: 'https://vk.com/clip-1' }, ctx()), refused('BUSY'));
});

test('settings and history', async () => {
  const { prefs } = await saveSettings({ videoQuality: '2160', audioFormat: 'opus', audioBitrate: '320', codec: 'vp9' }, ctx());
  assert.deepEqual(prefs, { videoQuality: '2160', audioFormat: 'opus', audioBitrate: '320', codec: 'vp9' });
  await assert.rejects(saveSettings({ codec: 'h266' }, ctx()), refused('BAD_VALUE'));
  assert.equal((await bootstrap({}, ctx())).prefs.codec, 'vp9');

  await resolve({ url: 'https://vk.com/clip-1' }, ctx());
  assert.equal((await history({}, ctx())).items.length, 1);
  assert.deepEqual(await clearHistoryEndpoint({}, ctx()), { items: [] });
  assert.equal((await history({}, ctx())).items.length, 0);
});
