// Local preview of the Mini App: `npm run preview`, then open the printed URL.
//
// The real endpoints run here on the sdk stand-ins (in-memory SQLite), behind
// a stub of telegram-web-app.js. Cobalt is a fake that serves sample files,
// unless COBALT_INSTANCES points at a real one:
//   COBALT_INSTANCES='https://dl.example.com|key' npm run preview
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EndpointError } from '../sdk/index.mjs';
import { bytes, file, fresh, json, serve } from '../helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const miniapp = join(root, 'miniapp');
const port = Number(process.env.PORT || 8787);

// A fake Cobalt: TikTok-ish links get a file, Instagram a gallery, anything
// with "private" an error.
const cobalt = await serve({
  'POST /': (req, res, body) => {
    const { url, downloadMode } = JSON.parse(body);
    if (/private/.test(url)) return json(res, 400, { status: 'error', error: { code: 'error.api.content.video.private' } });
    if (/instagram/.test(url)) {
      return json(res, 200, {
        status: 'picker',
        picker: [1, 2, 3, 4].map((i) => ({ type: i === 4 ? 'video' : 'photo', url: `${cobalt.base}/photo/${i}.svg`, thumb: i === 4 ? null : `${cobalt.base}/photo/${i}.svg` })),
      });
    }
    const audio = downloadMode === 'audio';
    return json(res, 200, {
      status: 'tunnel',
      url: `${cobalt.base}/tunnel/${audio ? 'song' : 'clip'}`,
      filename: audio ? 'Artist - Sample song.mp3' : 'Sample clip (1080p, h264).mp4',
    });
  },
  'GET /': (req, res) => json(res, 200, { cobalt: { version: 'preview', services: ['tiktok', 'instagram'] } }),
  '/tunnel/clip': (req, res) => file(res, bytes(150_000), { name: 'Sample clip (1080p, h264).mp4' }),
  '/tunnel/song': (req, res) => file(res, bytes(90_000), { name: 'Artist - Sample song.mp3', type: 'audio/mpeg' }),
  ...Object.fromEntries(
    [1, 2, 3, 4].map((i) => [
      `/photo/${i}.svg`,
      (req, res) => {
        const hue = i * 70;
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="hsl(${hue} 70% 60%)"/></svg>`);
      },
    ]),
  ),
});

await fresh({
  COBALT_INSTANCES: process.env.COBALT_INSTANCES || [cobalt.base],
  WORKER_URL: process.env.WORKER_URL || '',
  WORKER_SECRET: process.env.WORKER_SECRET || '',
  REQUIRED_CHANNEL: process.env.REQUIRED_CHANNEL || '',
  REQUIRED_CHANNEL_URL: process.env.REQUIRED_CHANNEL_URL || '',
  MINI_APP_URL: `http://127.0.0.1:${port}/`,
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const user = { id: 42, first_name: 'Ann' };

async function endpoint(name, input) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return [404, { ok: false, error_type: 'NOT_FOUND', description: 'no such endpoint' }];
  let mod;
  try {
    mod = await import(`../../tgcloud/endpoints/${name}.js`);
  } catch {
    return [404, { ok: false, error_type: 'NOT_FOUND', description: 'no such endpoint' }];
  }
  try {
    return [200, { ok: true, result: await mod.default(input, { initData: { user, auth_date: 1 } }) }];
  } catch (e) {
    if (e instanceof EndpointError) return [400, { ok: false, error_type: 'ENDPOINT_ERROR', description: e.description, parameters: e.parameters }];
    console.error(e);
    return [500, { ok: false, error_type: 'INTERNAL', description: 'Internal error' }];
  }
}

createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && path.startsWith('/api/')) {
    let body = '';
    for await (const c of req) body += c;
    const [status, data] = await endpoint(path.slice(5), body ? JSON.parse(body) : {});
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    return;
  }
  if (path === '/__telegram-stub.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(await readFile(new URL('./telegram-stub.js', import.meta.url)));
    return;
  }
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '');
  if (rel.startsWith('..')) return res.writeHead(400).end();
  try {
    let content = await readFile(join(miniapp, rel));
    if (rel === 'index.html') {
      content = content.toString().replace(/<script src="https:\/\/telegram\.org\/js\/telegram-web-app\.js[^"]*"><\/script>/, '<script src="/__telegram-stub.js"></script>');
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream' }).end(content);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Mini App preview: http://127.0.0.1:${port}/`);
  console.log('Try https://www.tiktok.com/@a/video/1, https://instagram.com/p/1 or a link with "private" in it.');
});
