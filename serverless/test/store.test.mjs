import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import * as store from '../tgcloud/lib/store.js';
import { db } from './sdk/db.mjs';
import { fresh } from './helpers.mjs';

beforeEach(() => fresh());

test('schema.js builds and every table is there', async () => {
  const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
  for (const name of ['users', 'links', 'jobs', 'downloads', 'instance_health']) assert.ok(tables.includes(name), name);
});

test('links: put, get, expiry', async () => {
  const token = await store.putLink('https://youtu.be/x', 42);
  assert.deepEqual(await store.getLink(token), { url: 'https://youtu.be/x', userId: 42 });
  assert.equal(await store.getLink('nope'), null);
  assert.equal(await store.getLink('x'.repeat(100)), null);

  await db.run('UPDATE links SET created_at = created_at - 90000');
  assert.equal(await store.getLink(token), null, 'older than a day');
  await store.putLink('https://youtu.be/y', 42);
  assert.equal((await db.get('SELECT count(*) AS n FROM links')).n, 1, 'pruned on the next put');
});

test('one job per user, and a stale lock expires', async () => {
  assert.equal(await store.acquireJob(42), true);
  assert.equal(await store.acquireJob(42), false);
  assert.equal(await store.acquireJob(43), true);
  await store.releaseJob(42);
  assert.equal(await store.acquireJob(42), true);

  await db.run('UPDATE jobs SET started_at = started_at - 3600 WHERE user_id = 43');
  assert.equal(await store.acquireJob(43), true, 'a crashed run does not lock the user out forever');
});

test('prefs fall back to the defaults and reject junk', async () => {
  assert.deepEqual(await store.getPrefs(42), { videoQuality: '1080', audioFormat: 'mp3', audioBitrate: '128', codec: 'h264' });
  await store.touchUser({ id: 42, first_name: 'Ann' });
  const prefs = await store.savePrefs(42, { videoQuality: '720', audioFormat: 'opus' });
  assert.equal(prefs.videoQuality, '720');
  assert.equal(prefs.audioFormat, 'opus');
  assert.equal(prefs.codec, 'h264');
  await assert.rejects(store.savePrefs(42, { codec: "h264'; DROP TABLE users; --" }), RangeError);
  // Saving before the user row exists creates it.
  assert.equal((await store.savePrefs(77, { audioBitrate: '320' })).audioBitrate, '320');
  await store.touchUser({ id: 77, first_name: 'Bob' });
  assert.equal((await store.getPrefs(77)).audioBitrate, '320', 'touchUser keeps prefs');
});

test('history: add, update, list newest first, trimmed to 50', async () => {
  const id = await store.addHistory({ userId: 42, url: 'https://a', mode: 'v', quality: '720' });
  assert.ok(id > 0);
  await store.updateHistory(id, { status: 'sent', title: 'clip.mp4', sizeBytes: 1234 });
  let items = await store.listHistory(42);
  assert.equal(items[0].status, 'sent');
  assert.equal(items[0].title, 'clip.mp4');
  assert.equal(items[0].sizeBytes, 1234);
  assert.equal(items[0].via, 'bot');

  for (let i = 0; i < 60; i++) await store.addHistory({ userId: 42, url: `https://a/${i}`, mode: 'a', via: 'app' });
  items = await store.listHistory(42, 100);
  assert.equal(items.length, 50);
  assert.equal(items[0].url, 'https://a/59');
  assert.equal(await store.recentRequests(42, 60), 50);
  await store.clearHistory(42);
  assert.equal((await store.listHistory(42)).length, 0);
});

test('instance health', async () => {
  await store.markInstance('https://a', 300, 'HTTP 502');
  await store.markInstance('https://b', 0, null);
  const cooling = await store.unhealthyInstances();
  assert.ok(cooling.has('https://a'));
  assert.ok(!cooling.has('https://b'));
  await store.markInstance('https://a', 0, null);
  assert.equal((await store.unhealthyInstances()).size, 0);
});
