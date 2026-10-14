// Shared test plumbing: a clean database and Bot API per test, local HTTP
// servers standing in for Cobalt, its tunnels and the worker.
import { createServer } from 'node:http';

import { buildConfig, config } from '../tgcloud/lib/config.js';
import * as schema from '../tgcloud/schema.js';
import { resetApi } from './sdk/api.mjs';
import { resetDb } from './sdk/db.mjs';

export { calls, callsOf, onApi } from './sdk/api.mjs';
export { BotApiError } from './sdk/api.mjs';

const BASE_SECRETS = { ADMIN_IDS: [1], MINI_APP_URL: 'https://app1.tgcloud.ai/' };

export async function fresh(secrets = {}) {
  await resetDb(schema);
  resetApi();
  Object.assign(config, buildConfig({ ...BASE_SECRETS, ...secrets }));
}

/**
 * Starts an HTTP server; `routes` maps 'METHOD /path' (or '/path' for any
 * method) to (req, res, body) handlers. Unknown paths answer 404.
 */
export async function serve(routes) {
  const hits = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const path = req.url.split('?')[0];
    hits.push({ method: req.method, path, url: req.url, headers: req.headers, body });
    const handler = routes[`${req.method} ${path}`] ?? routes[path];
    if (!handler) {
      res.writeHead(404).end('not found');
      return;
    }
    await handler(req, res, body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return { base, hits, close };
}

export function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

export function file(res, bytes, { name = 'clip.mp4', type = 'video/mp4', length = true } = {}) {
  const headers = { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` };
  if (length) headers['Content-Length'] = String(bytes.length);
  res.writeHead(200, headers);
  res.end(Buffer.from(bytes));
}

export function bytes(n, fill = 7) {
  return new Uint8Array(n).fill(fill);
}

export const user = { id: 42, is_bot: false, first_name: 'Ann', username: 'ann', language_code: 'ru' };

export function privateMessage(text, extra = {}) {
  return { message_id: 10, date: 1, chat: { id: 42, type: 'private' }, from: user, text, ...extra };
}
