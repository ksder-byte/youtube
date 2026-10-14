import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { EmptyDownload, FileTooLarge, HttpError, fetchFile } from '../tgcloud/lib/download.js';
import { bytes, file, serve } from './helpers.mjs';

let srv;
before(async () => {
  srv = await serve({
    '/clip': (req, res) => file(res, bytes(1000), { name: 'clip.mp4' }),
    '/chunked': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.write(Buffer.from(bytes(600)));
      res.end(Buffer.from(bytes(600)));
    },
    '/estimated': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Estimated-Content-Length': '5000000' });
      res.end(Buffer.from(bytes(10)));
    },
    '/empty': (req, res) => res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(),
    '/noname': (req, res) => file(res, bytes(10), { name: '', type: 'image/jpeg' }),
  });
});
after(() => srv.close());

test('reads the whole file with its name and type', async () => {
  const f = await fetchFile(`${srv.base}/clip`, { limitBytes: 5000 });
  assert.equal(f.size, 1000);
  assert.equal(f.bytes.length, 1000);
  assert.equal(f.name, 'clip.mp4');
  assert.equal(f.type, 'video/mp4');
});

test('refuses early when the declared size is over the limit', async () => {
  await assert.rejects(fetchFile(`${srv.base}/clip`, { limitBytes: 999 }), (e) => e instanceof FileTooLarge && e.sizeBytes === 1000);
  await assert.rejects(fetchFile(`${srv.base}/estimated`, { limitBytes: 1000 }), FileTooLarge);
});

test('stops a stream without a length once it passes the limit', async () => {
  await assert.rejects(fetchFile(`${srv.base}/chunked`, { limitBytes: 1000 }), (e) => e instanceof FileTooLarge && e.sizeBytes === null);
  const f = await fetchFile(`${srv.base}/chunked`, { limitBytes: 2000, fallbackName: 'audio.mp3' });
  assert.equal(f.size, 1200);
  // No name in the headers and none in the path: the caller's fallback wins.
  assert.equal(f.name, 'audio.mp3');
});

test('empty body and HTTP errors', async () => {
  await assert.rejects(fetchFile(`${srv.base}/empty`, { limitBytes: 1000 }), EmptyDownload);
  await assert.rejects(fetchFile(`${srv.base}/missing`, { limitBytes: 1000 }), (e) => e instanceof HttpError && e.status === 404);
});

test('a nameless file keeps the fallback name', async () => {
  const f = await fetchFile(`${srv.base}/noname`, { limitBytes: 1000, fallbackName: 'media_1' });
  assert.equal(f.name, 'media_1.jpg', 'the extension comes from the content type');
});

test('progress is reported every 10%, throttled in time', async () => {
  const big = await serve({ '/big': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(4 * 65536) });
    let i = 0;
    const push = () => {
      if (i++ === 4) return res.end();
      res.write(Buffer.from(bytes(65536)), () => setTimeout(push, 5));
    };
    push();
  } });
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => (clock += 4000);
  try {
    const seen = [];
    const f = await fetchFile(`${big.base}/big`, { limitBytes: 1e6, onProgress: (p) => seen.push(p) });
    assert.equal(f.size, 4 * 65536);
    assert.ok(seen.length >= 2, `got ${seen}`);
    assert.ok(seen.every((p, i) => p < 100 && (i === 0 || p >= seen[i - 1] + 10)));
  } finally {
    Date.now = realNow;
    await big.close();
  }
});
