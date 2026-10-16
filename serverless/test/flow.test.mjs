// End to end through the handlers and the pipeline, with Cobalt, its tunnels
// and the worker as local HTTP servers.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import callbackQuery from '../tgcloud/handlers/callback_query.js';
import message from '../tgcloud/handlers/message.js';
import { config } from '../tgcloud/lib/config.js';
import { acquireJob, getLink, getPrefs, listHistory } from '../tgcloud/lib/store.js';
import * as texts from '../tgcloud/lib/texts.js';
import { BotApiError, bytes, calls, callsOf, file, fresh, json, onApi, privateMessage, serve, user } from './helpers.mjs';

const SECRET = 'w'.repeat(40);
let servers = [];
let cobaltAnswer;
let cobalt, worker;
let workerStatus = 202;

beforeEach(async () => {
  cobaltAnswer = null;
  workerStatus = 202;
  cobalt = await serve({
    'POST /': (req, res, body) => {
      const payload = JSON.parse(body);
      const answer = typeof cobaltAnswer === 'function' ? cobaltAnswer(payload) : cobaltAnswer;
      json(res, 200, answer ?? { status: 'tunnel', url: `${cobalt.base}/tunnel/clip`, filename: 'clip.mp4' });
    },
    'GET /': (req, res) => json(res, 200, { cobalt: { version: '11.7.1', services: ['tiktok'] } }),
    '/tunnel/clip': (req, res) => file(res, bytes(2048), { name: 'Cool clip (1080p).mp4' }),
    '/tunnel/song': (req, res) => file(res, bytes(1024), { name: 'Artist - Song.mp3', type: 'audio/mpeg' }),
    '/tunnel/big': (req, res) => file(res, bytes(64), { name: 'big.mp4' }),
    '/tunnel/empty': (req, res) => res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(),
    '/p/photo': (req, res) => file(res, bytes(100), { name: 'p.jpg', type: 'image/jpeg' }),
    '/p/gif': (req, res) => file(res, bytes(100), { name: 'g.gif', type: 'image/gif' }),
  });
  worker = await serve({
    'POST /worker/v1/jobs': (req, res) => json(res, workerStatus, workerStatus === 202 ? { accepted: true } : { error: 'nope' }),
    'GET /worker/healthz': (req, res) => json(res, 200, { ok: true, ytdlp: '2026.08.19', jobs: 0, max_queue: 20 }),
  });
  servers = [cobalt, worker];
  await fresh({ COBALT_INSTANCES: [cobalt.base] });
});

afterEach(async () => {
  for (const s of servers) await s.close();
  // The SDK passes params through as they are: camelCase would be silently ignored.
  for (const { method, params } of calls) {
    for (const key of Object.keys(params)) assert.doesNotMatch(key, /[A-Z]/, `${method}.${key}`);
  }
});

function withWorker(extra = {}) {
  return fresh({ COBALT_INSTANCES: [cobalt.base], WORKER_URL: `${worker.base}/worker`, WORKER_SECRET: SECRET, ...extra });
}

/** Sends a link, returns the token of the buttons the bot answered with. */
async function sendLink(url) {
  await message(privateMessage(url));
  const reply = callsOf('sendMessage').at(-1);
  assert.equal(reply.text, texts.CHOOSE_ACTION);
  return reply.reply_markup.inline_keyboard[0][0].callback_data.split(':')[3];
}

function press(data, messageId = 500) {
  return callbackQuery({ id: 'cb1', from: user, data, message: { message_id: messageId, date: 1, chat: { id: 42, type: 'private' } } });
}

const lastEdit = () => callsOf('editMessageText').at(-1);

// ── messages ──────────────────────────────────────────────────────────────

test('/start greets with a Mini App button', async () => {
  await message(privateMessage('/start'));
  const [reply] = callsOf('sendMessage');
  assert.equal(reply.parse_mode, 'HTML');
  assert.match(reply.text, /Привет/);
  assert.equal(reply.reply_markup.inline_keyboard[0][0].web_app.url, 'https://app1.tgcloud.ai/');
});

test('a link gets the action buttons with the user\'s default quality', async () => {
  const token = await sendLink('https://www.tiktok.com/@a/video/1');
  assert.equal((await getLink(token)).url, 'https://www.tiktok.com/@a/video/1');
  const kb = callsOf('sendMessage')[0].reply_markup.inline_keyboard;
  assert.equal(kb[0][0].callback_data, `dl:v:1080:${token}`);
  assert.equal(kb[0][1].callback_data, `dl:a:-:${token}`);
  assert.equal(kb[1][1].web_app.url, `https://app1.tgcloud.ai/?t=${token}`);
});

test('text without a link: a hint in private, silence in groups', async () => {
  await message(privateMessage('привет'));
  assert.equal(callsOf('sendMessage')[0].text, texts.NOT_A_LINK);
  await message({ ...privateMessage('привет'), chat: { id: -100, type: 'supergroup' } });
  assert.equal(callsOf('sendMessage').length, 1);
});

test('commands for another bot and unknown commands are ignored', async () => {
  await message(privateMessage('/help@other_bot'));
  await message(privateMessage('/nonsense'));
  assert.equal(callsOf('sendMessage').length, 0);
  await message(privateMessage('/help@test_bot'));
  assert.match(callsOf('sendMessage')[0].text, /Как пользоваться/);
});

test('forced subscription', async () => {
  await fresh({ COBALT_INSTANCES: [cobalt.base], REQUIRED_CHANNEL: '@chan', REQUIRED_CHANNEL_URL: 'https://t.me/chan' });
  onApi('getChatMember', () => ({ status: 'left' }));
  await message(privateMessage('https://youtu.be/x'));
  const reply = callsOf('sendMessage')[0];
  assert.equal(reply.text, texts.SUBSCRIBE_REQUIRED);
  assert.equal(reply.reply_markup.inline_keyboard[0][0].url, 'https://t.me/chan');

  // A misconfigured channel fails open instead of locking everyone out.
  onApi('getChatMember', () => {
    throw new BotApiError('getChatMember', 400, 'Bad Request: member list is inaccessible');
  });
  await message(privateMessage('https://youtu.be/x'));
  assert.equal(callsOf('sendMessage').at(-1).text, texts.CHOOSE_ACTION);
});

// ── the Cobalt path ───────────────────────────────────────────────────────

test('video: Cobalt tunnel -> sendVideo, status message removed', async () => {
  const token = await sendLink('https://www.tiktok.com/@a/video/1');
  await press(`dl:v:720:${token}`);

  assert.equal(JSON.parse(cobalt.hits.find((h) => h.method === 'POST').body).videoQuality, '720');
  const [video] = callsOf('sendVideo');
  assert.equal(video.chat_id, 42);
  assert.equal(video.video.filename, 'Cool clip (1080p).mp4');
  assert.equal(video.video.bytes.length, 2048);
  assert.equal(video.supports_streaming, true);
  assert.deepEqual(callsOf('deleteMessage')[0], { chat_id: 42, message_id: 500 });

  const [entry] = await listHistory(42);
  assert.equal(entry.status, 'sent');
  assert.equal(entry.quality, '720');
  assert.equal(await acquireJob(42), true, 'the lock is released');
});

test('audio: sendAudio with tags from the file name', async () => {
  cobaltAnswer = { status: 'tunnel', url: `${cobalt.base}/tunnel/song`, filename: 'Artist - Song.mp3' };
  const token = await sendLink('https://soundcloud.com/a/b');
  await press(`dl:a:-:${token}`);
  assert.equal(JSON.parse(cobalt.hits.find((h) => h.method === 'POST').body).downloadMode, 'audio');
  const [audio] = callsOf('sendAudio');
  assert.equal(audio.performer, 'Artist');
  assert.equal(audio.title, 'Song');
});

test('quality menu and settings buttons', async () => {
  const token = await sendLink('https://vk.com/clip-1_2');
  await press(`q:${token}`);
  assert.equal(lastEdit().text, texts.CHOOSE_QUALITY);
  assert.equal(lastEdit().reply_markup.inline_keyboard[2][0].callback_data, `dl:v:max:${token}`);

  await press('set:q:720');
  assert.equal((await getPrefs(42)).videoQuality, '720');
  assert.match(lastEdit().text, /720p/);
  await press('set:q:9999');
  assert.equal((await getPrefs(42)).videoQuality, '720', 'junk is ignored');
});

test('a second download while one runs is refused', async () => {
  const token = await sendLink('https://www.tiktok.com/@a/video/1');
  await acquireJob(42);
  await press(`dl:v:720:${token}`);
  const answer = callsOf('answerCallbackQuery').at(-1);
  assert.equal(answer.text, texts.BUSY);
  assert.equal(answer.show_alert, true);
  assert.equal(callsOf('sendVideo').length, 0);
});

test('expired token and an inaccessible message', async () => {
  await press('dl:v:720:missing');
  assert.equal(callsOf('answerCallbackQuery').at(-1).text, texts.LINK_EXPIRED);
  await callbackQuery({ id: 'cb', from: user, data: 'dl:v:720:x', message: { message_id: 1, date: 0, chat: { id: 42 } } });
  assert.equal(callsOf('answerCallbackQuery').at(-1).text, texts.LINK_EXPIRED);
});

test('Cobalt error codes become readable text', async () => {
  cobaltAnswer = { status: 'error', error: { code: 'error.api.content.video.private' } };
  const token = await sendLink('https://www.tiktok.com/@a/video/1');
  await press(`dl:v:720:${token}`);
  assert.equal(lastEdit().text, texts.cobaltError('error.api.content.video.private'));
  assert.equal((await listHistory(42))[0].status, 'error');
});

test('too large without a worker: lower qualities, audio and a direct link', async () => {
  await fresh({ COBALT_INSTANCES: [cobalt.base], INLINE_LIMIT_MB: 0.00001 });
  cobaltAnswer = { status: 'tunnel', url: `${cobalt.base}/tunnel/clip`, filename: 'clip.mp4' };
  const token = await sendLink('https://www.tiktok.com/@a/video/1');
  await press(`dl:v:1080:${token}`);
  const edit = lastEdit();
  assert.match(edit.text, /Файл весит/);
  const buttons = edit.reply_markup.inline_keyboard.flat();
  assert.deepEqual(edit.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`dl:v:720:${token}`, `dl:v:480:${token}`, `dl:v:360:${token}`]);
  assert.ok(buttons.some((b) => b.web_app));
  assert.equal(callsOf('sendVideo').length, 0);
  assert.equal((await listHistory(42))[0].status, 'too_large');
});

test('picker: albums of up to 10, gifs apart', async () => {
  cobaltAnswer = {
    status: 'picker',
    picker: [
      ...Array.from({ length: 12 }, () => ({ type: 'photo', url: `${cobalt.base}/p/photo` })),
      { type: 'gif', url: `${cobalt.base}/p/gif` },
      { type: 'photo', url: `${cobalt.base}/p/missing` },
    ],
  };
  const token = await sendLink('https://instagram.com/p/abc');
  await press(`dl:v:1080:${token}`);
  const groups = callsOf('sendMediaGroup');
  assert.deepEqual(groups.map((g) => g.media.length), [10, 2]);
  assert.equal(groups[0].media[0].type, 'photo');
  assert.equal(callsOf('sendAnimation').length, 1);
  assert.equal(lastEdit().text, texts.pickerSkipped(1));
});

test('local processing without a worker cannot be muxed here', async () => {
  cobaltAnswer = { status: 'local-processing', tunnel: [`${cobalt.base}/tunnel/clip`, `${cobalt.base}/tunnel/song`], output: { filename: 'x.mp4' } };
  const token = await sendLink('https://www.tiktok.com/@a/video/1');
  await press(`dl:v:1080:${token}`);
  assert.equal(lastEdit().text, texts.LOCAL_PROCESSING);
});

test('nothing configured', async () => {
  await fresh({});
  const token = await sendLink('https://www.tiktok.com/@a/video/1');
  await press(`dl:v:1080:${token}`);
  assert.equal(lastEdit().text, texts.NOT_CONFIGURED);
});

// ── the worker ────────────────────────────────────────────────────────────

test('YouTube goes to the worker with the status message and the user\'s prefs', async () => {
  await withWorker();
  await message(privateMessage('/settings'));
  await press('set:a:opus');
  const token = await sendLink('https://youtu.be/aqz-KE-bpKQ');
  await press(`dl:v:720:${token}`, 777);

  assert.equal(cobalt.hits.filter((h) => h.method === 'POST').length, 0, 'Cobalt is not asked about YouTube');
  const hit = worker.hits.find((h) => h.path === '/worker/v1/jobs');
  assert.equal(hit.headers.authorization, `Bearer ${SECRET}`);
  const job = JSON.parse(hit.body);
  assert.deepEqual(
    { chat: job.chat_id, msg: job.message_id, user: job.user_id, mode: job.mode, q: job.quality, token: job.token },
    { chat: 42, msg: 777, user: 42, mode: 'v', q: '720', token },
  );
  assert.equal(job.prefs.audio_format, 'opus');
  assert.equal(lastEdit().text, texts.HANDING_OFF);
  assert.equal((await listHistory(42))[0].status, 'worker');
  assert.equal(await acquireJob(42), true, 'the worker keeps its own lock');
});

test('a file over the inline limit goes to the worker', async () => {
  await withWorker({ INLINE_LIMIT_MB: 0.00001 });
  const token = await sendLink('https://www.tiktok.com/@a/video/1');
  await press(`dl:v:1080:${token}`);
  assert.equal(worker.hits.filter((h) => h.path === '/worker/v1/jobs').length, 1);
  assert.equal(lastEdit().text, texts.HANDING_OFF_LARGE);
});

test('an empty tunnel goes to the worker, which can mux', async () => {
  await withWorker();
  cobaltAnswer = { status: 'tunnel', url: `${cobalt.base}/tunnel/empty`, filename: 'x.mp4' };
  const token = await sendLink('https://www.tiktok.com/@a/video/1');
  await press(`dl:v:1080:${token}`);
  assert.equal(worker.hits.filter((h) => h.path === '/worker/v1/jobs').length, 1);
});

test('worker answers: busy, overloaded, down', async () => {
  await withWorker();
  for (const [status, text] of [[409, texts.WORKER_BUSY], [503, texts.WORKER_OVERLOADED], [500, texts.WORKER_UNAVAILABLE]]) {
    workerStatus = status;
    const token = await sendLink('https://youtu.be/x');
    await press(`dl:v:720:${token}`);
    assert.equal(lastEdit().text, text);
  }
});

test('YOUTUBE_VIA_WORKER=false sends YouTube to Cobalt too', async () => {
  await withWorker({ YOUTUBE_VIA_WORKER: false });
  const token = await sendLink('https://youtu.be/x');
  await press(`dl:v:720:${token}`);
  assert.equal(worker.hits.length, 0);
  assert.equal(callsOf('sendVideo').length, 1);
});

test('/status reports Cobalt and the worker', async () => {
  await withWorker();
  await message(privateMessage('/status'));
  const text = callsOf('sendMessage')[0].text;
  assert.match(text, /v11\.7\.1/);
  assert.match(text, /yt-dlp 2026\.08\.19/);
});

test('/setup is for admins only', async () => {
  await message({ ...privateMessage('/setup'), from: { ...user, id: 5 } });
  assert.equal(callsOf('sendMessage')[0].text, texts.ADMIN_ONLY);
  assert.equal(callsOf('setMyCommands').length, 0);

  await message({ ...privateMessage('/setup'), from: { ...user, id: 1 } });
  assert.equal(callsOf('setMyCommands')[0].commands.length, 5);
  assert.equal(callsOf('setChatMenuButton')[0].menu_button.web_app.url, 'https://app1.tgcloud.ai/');
});

test('/diag shows what Telegram\'s cloud can reach, with the real error', async () => {
  await message({ ...privateMessage('/diag'), from: { ...user, id: 5 } });
  assert.equal(callsOf('sendMessage')[0].text, texts.ADMIN_ONLY);

  const trace = await serve({ '/cdn-cgi/trace': (req, res) => res.writeHead(200, { Server: 'cloudflare' }).end('ip=203.0.113.7\nloc=NL\nhttp=http/2\ntls=TLSv1.3\n') });
  servers.push(trace);
  config.diagUrls = [`${trace.base}/cdn-cgi/trace`, 'http://127.0.0.1:9/'];
  await message({ ...privateMessage('/diag'), from: { ...user, id: 1 } });
  const text = callsOf('sendMessage').at(-1).text;
  assert.match(text, /ip=203\.0\.113\.7 loc=NL http=http\/2 tls=TLSv1\.3/);
  assert.match(text, /❌ <code>127\.0\.0\.1:9\/<\/code>\n {3}fetch failed \(.+\)/, "the cause is shown, not just \"fetch failed\"");
  assert.match(text, /Cobalt v11\.7\.1/);
});
