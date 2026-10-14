#!/usr/bin/env node
// Runs before `npm run deploy`: makes sure tgcloud/lib/secrets.js exists and
// holds something the bot can work with. Creates it from the template on the
// first run.
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'tgcloud', 'lib', 'secrets.js');
const template = join(root, 'secrets.example.js');

const problems = [];
const warnings = [];

if (!existsSync(target)) {
  copyFileSync(template, target);
  console.error('[+] Created tgcloud/lib/secrets.js from secrets.example.js.');
  console.error('    Fill it in (Cobalt instances and/or the worker), then run the command again.');
  process.exit(1);
}

const { default: s } = await import(pathToFileURL(target).href);
if (!s || typeof s !== 'object') {
  console.error('[!] tgcloud/lib/secrets.js must `export default { ... }`.');
  process.exit(1);
}

const isHttps = (url) => /^https:\/\/[^\s/]+/i.test(String(url ?? ''));
const instances = Array.isArray(s.COBALT_INSTANCES) ? s.COBALT_INSTANCES : String(s.COBALT_INSTANCES ?? '').split(/[,\n]/);
const cobalt = instances.map((i) => String(i).trim()).filter(Boolean);

for (const item of cobalt) {
  const url = item.split('|')[0];
  if (!isHttps(url)) problems.push(`COBALT_INSTANCES: "${url}" must be a public https:// address`);
  if (/^https?:\/\/(localhost|127\.|10\.|192\.168\.|cobalt[:/])/i.test(url)) {
    problems.push(`COBALT_INSTANCES: "${url}" is not reachable from Telegram's cloud`);
  }
}

const worker = Boolean(s.WORKER_URL);
if (worker) {
  if (!isHttps(s.WORKER_URL)) problems.push('WORKER_URL must be a public https:// address');
  if (!/\/worker\/?$/.test(String(s.WORKER_URL))) warnings.push('WORKER_URL usually ends with /worker (see the Caddyfile)');
  if (String(s.WORKER_SECRET ?? '').length < 32) problems.push('WORKER_SECRET must be at least 32 characters, the same as in the server\'s .env');
}

if (!cobalt.length && !worker) problems.push('nothing to download with: set COBALT_INSTANCES, WORKER_URL, or both');
if (!worker) warnings.push('no worker: YouTube depends on your Cobalt instance having a working YouTube session');
if (s.MINI_APP_URL && !/^https:\/\/app\d+\.tgcloud\.ai\/?/.test(String(s.MINI_APP_URL))) {
  warnings.push('MINI_APP_URL is usually https://app<app_id>.tgcloud.ai/ — `npm run deploy` prints it');
}
if (!s.MINI_APP_URL) warnings.push('MINI_APP_URL is empty: the bot will not show Mini App buttons (set it after the first deploy)');

for (const w of warnings) console.warn(`[i] ${w}`);
if (problems.length) {
  for (const p of problems) console.error(`[!] ${p}`);
  process.exit(1);
}
console.log('[ok] tgcloud/lib/secrets.js looks fine.');
