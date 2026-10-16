import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildConfig, parseInstances } from '../tgcloud/lib/config.js';
import { kindOf, nameFromHeaders, safeFilename } from '../tgcloud/lib/download.js';
import { packDownload, unpackDownload, fallbackKb, actionsKb } from '../tgcloud/lib/keyboards.js';
import { cleanUrl, extractUrl, isYoutube } from '../tgcloud/lib/links.js';
import { audioTags } from '../tgcloud/lib/send.js';
import { describeError, parseUrl, randomToken } from '../tgcloud/lib/util.js';
import { cobaltError, tooLarge } from '../tgcloud/lib/texts.js';
import { fresh } from './helpers.mjs';

test('extractUrl reads entities, adds a missing scheme and trims punctuation', () => {
  const text = 'глянь youtube.com/watch?v=abc, круто';
  const offset = text.indexOf('youtube');
  assert.equal(
    extractUrl({ text, entities: [{ type: 'url', offset, length: 'youtube.com/watch?v=abc,'.length }] }),
    'https://youtube.com/watch?v=abc',
  );
  assert.equal(
    extractUrl({ text: 'тык', entities: [{ type: 'text_link', offset: 0, length: 3, url: 'https://vk.com/clip1' }] }),
    'https://vk.com/clip1',
  );
  assert.equal(extractUrl({ text: 'see https://x.com/a/status/1).' }), 'https://x.com/a/status/1');
  assert.equal(extractUrl({ text: 'https://en.wikipedia.org/wiki/Foo_(bar)' }), 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(extractUrl({ caption: 'видео https://youtu.be/xyz' }), 'https://youtu.be/xyz');
  assert.equal(extractUrl({ text: 'просто текст' }), null);
});

test('extractUrl counts entity offsets in UTF-16 like Telegram', () => {
  const text = '🎬🎬 https://youtu.be/emoji';
  assert.equal(extractUrl({ text, entities: [{ type: 'url', offset: 5, length: 22 }] }), 'https://youtu.be/emoji');
});

test('cleanUrl rejects what Cobalt cannot take', () => {
  assert.equal(cleanUrl('javascript:alert(1)'), null);
  assert.equal(cleanUrl(''), null);
  assert.equal(cleanUrl('  https://tiktok.com/@a/video/1  '), 'https://tiktok.com/@a/video/1');
});

test('isYoutube', () => {
  assert.ok(isYoutube('https://www.youtube.com/shorts/abc'));
  assert.ok(isYoutube('https://youtu.be/abc'));
  assert.ok(isYoutube('https://music.youtube.com/watch?v=abc'));
  assert.ok(!isYoutube('https://notyoutube.com/watch?v=abc'));
  assert.ok(!isYoutube('https://youtube.com.evil.org/x'));
});

test('parseUrl works without the URL global too', () => {
  const saved = globalThis.URL;
  try {
    globalThis.URL = undefined;
    assert.deepEqual(parseUrl('https://User@Example.com:8443/path?q=1'), {
      protocol: 'https:',
      host: 'example.com:8443',
      hostname: 'example.com',
      pathname: '/path',
    });
    assert.equal(parseUrl('not a url'), null);
  } finally {
    globalThis.URL = saved;
  }
});

test('parseInstances: keys, defaults, duplicates and junk', () => {
  const list = parseInstances(['https://a.example/|k1', 'https://b.example', 'https://a.example', 'ftp://c', 'junk'], 'dflt');
  assert.deepEqual(list, [
    { url: 'https://a.example', apiKey: 'k1', label: 'a.example' },
    { url: 'https://b.example', apiKey: 'dflt', label: 'b.example' },
  ]);
  assert.equal(parseInstances('https://x.example, https://y.example|key').length, 2);
});

test('buildConfig: defaults, the 30 MB cap and the worker switch', () => {
  const c = buildConfig({ INLINE_LIMIT_MB: 100, VIDEO_QUALITY: 'MAX', AUDIO_FORMAT: 'flac', WORKER_URL: 'https://w/worker/' });
  assert.equal(c.inlineLimitMb, 30);
  assert.equal(c.defaults.videoQuality, 'max');
  assert.equal(c.defaults.audioFormat, 'mp3');
  assert.equal(c.worker, false, 'no secret, no worker');
  assert.equal(buildConfig({ WORKER_URL: 'https://w/worker/', WORKER_SECRET: 'x'.repeat(40) }).workerUrl, 'https://w/worker');
});

test('download helpers', () => {
  const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
  assert.equal(
    nameFromHeaders(headers({ 'content-disposition': "attachment; filename*=UTF-8''%D0%9F%D0%B5%D1%81%D0%BD%D1%8F.mp3" })),
    'Песня.mp3',
  );
  assert.equal(nameFromHeaders(headers({ 'content-disposition': 'attachment; filename="clip (720p).mp4"' })), 'clip (720p).mp4');
  assert.equal(nameFromHeaders(headers({}), 'https://cdn/x/photo.jpg?sig=1'), 'photo.jpg');
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('a<b>c?.mp4'), 'a_b_c_.mp4');
  assert.equal(safeFilename('...'), 'download.bin');
  assert.equal(safeFilename(`${'x'.repeat(200)}.mp4`).length, 114);
  assert.equal(kindOf('a.MP4'), 'video');
  assert.equal(kindOf('a.opus'), 'audio');
  assert.equal(kindOf('a.gif'), 'animation');
  assert.equal(kindOf('blob', 'image/png'), 'photo');
  assert.equal(kindOf('x.bin'), 'document');
});

test('audio tags from a Cobalt file name', () => {
  assert.deepEqual(audioTags('Artist - Song Title.mp3'), { performer: 'Artist', title: 'Song Title' });
  assert.deepEqual(audioTags('Just a title.mp3'), { title: 'Just a title' });
});

test('callback data round-trips and fits in 64 bytes', () => {
  const token = randomToken(10);
  assert.match(token, /^[A-Za-z0-9_-]{10}$/);
  const data = packDownload('v', '1080', token);
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.deepEqual(unpackDownload(data), { mode: 'v', quality: '1080', token });
  assert.equal(unpackDownload('dl:x:1:t'), null);
  assert.equal(unpackDownload('junk'), null);
});

test('keyboards: web_app buttons only in private chats, lower qualities only', async () => {
  await fresh();
  const priv = actionsKb('tok', '1080', true);
  assert.equal(priv.inline_keyboard[1][1].web_app.url, 'https://app1.tgcloud.ai/?t=tok');
  const group = actionsKb('tok', '1080', false);
  assert.equal(group.inline_keyboard[1].length, 1);

  const fb = fallbackKb('tok', '720', { directUrl: 'https://cobalt/tunnel?id=1' });
  const texts = fb.inline_keyboard.flat().map((b) => b.text);
  assert.deepEqual(fb.inline_keyboard[0].map((b) => b.callback_data), ['dl:v:480:tok', 'dl:v:360:tok']);
  assert.ok(texts.includes('🔗 Прямая ссылка (временная)'));
  assert.ok(!fallbackKb('tok', '720', { directUrl: 'http://insecure' }).inline_keyboard.flat().some((b) => b.url));
});

test('texts', () => {
  assert.match(cobaltError('error.api.content.video.private'), /приватное/);
  assert.match(cobaltError('error.api.<weird>'), /error\.api\.weird/);
  assert.match(tooLarge(73.4, 30), /~73 МБ.*30 МБ/s);
});

test('tgcloud/ modules only import what the platform resolves', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join, dirname, resolve, relative } = await import('node:path');
  const root = resolve(import.meta.dirname, '../tgcloud');
  const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.js')).map((f) => join(root, f));
  assert.ok(files.length > 20);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [, spec] of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      const where = `${relative(root, file)}: ${spec}`;
      if (spec.startsWith('.')) {
        assert.ok(spec.endsWith('.js'), `${where} — relative imports need .js`);
        assert.ok(!relative(root, resolve(dirname(file), spec)).startsWith('..'), `${where} — leaves tgcloud/`);
      } else {
        assert.match(spec, /^sdk(\/(db|api|fetch))?$/, `${where} — only sdk is available at runtime`);
      }
    }
    assert.doesNotMatch(source, /\bBuffer\b|\bprocess\.|require\(/, `${relative(root, file)} uses a Node-only API`);
  }
});

test('describeError keeps the cause and code a bare message hides', () => {
  const inner = Object.assign(new Error('getaddrinfo ENOTFOUND x.example'), { code: 'ENOTFOUND' });
  assert.equal(describeError(new Error('fetch failed', { cause: inner })), 'fetch failed (getaddrinfo ENOTFOUND x.example)');
  assert.equal(describeError(Object.assign(new Error('request failed'), { code: 'ECONNRESET' })), 'request failed [ECONNRESET]');
  assert.equal(describeError(null), 'unknown error');
});
