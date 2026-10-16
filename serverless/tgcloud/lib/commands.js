// Bot commands: /start /help /status /settings /app /setup.

import { api, fetch } from 'sdk';
import { survey } from './cobalt.js';
import { config } from './config.js';
import { appButton, settingsKb } from './keyboards.js';
import { getPrefs } from './store.js';
import { say } from './telegram.js';
import * as texts from './texts.js';
import { describeError, escapeHtml, withTimeout } from './util.js';
import { workerHealth } from './worker.js';

export const COMMANDS = [
  { command: 'start', description: 'Начать работу' },
  { command: 'help', description: 'Как пользоваться' },
  { command: 'settings', description: 'Качество по умолчанию' },
  { command: 'app', description: 'Открыть Mini App' },
  { command: 'status', description: 'Состояние Cobalt и загрузчика' },
];

function isPrivate(message) {
  return message.chat?.type === 'private';
}

export async function start(message) {
  const app = appButton('📱 Открыть Mini App', '', isPrivate(message));
  const text = app ? `${texts.START}\n\n${texts.START_APP}` : texts.START;
  await say(message.chat.id, text, app ? { reply_markup: { inline_keyboard: [[app]] } } : {});
}

export async function help(message) {
  await say(message.chat.id, texts.HELP);
}

export async function app(message) {
  const button = appButton('📱 Открыть', '', isPrivate(message));
  if (!button) return say(message.chat.id, config.miniAppUrl ? texts.OPEN_APP_PRIVATE : texts.NO_APP);
  await say(message.chat.id, texts.OPEN_APP, { reply_markup: { inline_keyboard: [[button]] } });
}

export function settingsText(prefs) {
  return texts.SETTINGS.replace('{quality}', prefs.videoQuality === 'max' ? 'максимум' : `${prefs.videoQuality}p`).replace(
    '{format}',
    prefs.audioFormat,
  );
}

export async function settings(message) {
  const prefs = await getPrefs(message.from.id);
  await say(message.chat.id, settingsText(prefs), { reply_markup: settingsKb(prefs, isPrivate(message)) });
}

export async function status(message) {
  const lines = [];
  if (config.cobaltInstances.length) {
    lines.push('<b>Инстансы Cobalt</b>');
    const probes = await survey();
    probes.forEach((p, i) => {
      const role = i === 0 ? 'основной' : 'запасной';
      const label = `<code>${escapeHtml(p.instance.label)}</code>`;
      if (!p.ok) lines.push(`❌ ${label} — ${escapeHtml(p.error)} (${role})`);
      else
        lines.push(
          `✅ ${label} — v${escapeHtml(p.version)}, площадок: ${p.services.length}` +
            `${p.youtube ? ', с YouTube' : ', без YouTube'}, ${p.latencyMs} мс (${role})`,
        );
    });
  } else {
    lines.push('Cobalt: не настроен');
  }

  if (config.worker) {
    const health = await workerHealth();
    lines.push('', '<b>Загрузчик</b>');
    if (!health.ok) lines.push(`❌ недоступен: ${escapeHtml(health.error ?? 'нет ответа')}`);
    else
      lines.push(
        `✅ на связи, yt-dlp ${escapeHtml(health.ytdlp ?? '?')}, задач: ${health.jobs ?? 0}/${health.max_queue ?? '?'}` +
          (config.youtubeViaWorker ? '\n🎬 YouTube качает yt-dlp' : ''),
      );
  } else {
    lines.push('', 'Загрузчик: не подключён — YouTube только через Cobalt');
  }

  lines.push(
    '',
    `Лимит отправки: <b>${config.inlineLimitMb} МБ</b> прямо отсюда` +
      (config.worker ? ', до <b>50 МБ</b> через загрузчик' : ''),
  );
  await say(message.chat.id, lines.join('\n'));
}

/** Registers the command list and the menu button. Admins only. */
export async function setup(message) {
  if (!config.adminIds.includes(message.from.id)) return say(message.chat.id, texts.ADMIN_ONLY);
  await api.setMyCommands({ commands: COMMANDS });
  let menu = '';
  if (config.miniAppUrl) {
    await api.setChatMenuButton({
      menu_button: { type: 'web_app', text: 'Скачать', web_app: { url: config.miniAppUrl } },
    });
    menu = ' и кнопка меню ведёт в Mini App';
  }
  await say(message.chat.id, texts.SETUP_DONE.replace('{menu}', menu));
}

async function probeUrl(target) {
  const started = Date.now();
  try {
    const res = await withTimeout(
      fetch(target.url, { headers: { 'User-Agent': 'cobalt-telegram-bot/2.0 (diag)', ...target.headers } }),
      15_000,
    );
    const body = await res.text();
    return { ...target, ok: true, status: res.status, ms: Date.now() - started, server: res.headers.get('server'), body };
  } catch (e) {
    // The whole error, cause included, for `npx tgcloud run`.
    console.error(`diag: ${target.url}`, e);
    return { ...target, ok: false, ms: Date.now() - started, error: describeError(e) };
  }
}

function diagDetails(r) {
  // Cloudflare's trace says which address and protocol the platform used.
  if (r.url.endsWith('/cdn-cgi/trace')) {
    const fields = Object.fromEntries(r.body.split('\n').map((l) => l.split('=')).filter((kv) => kv.length === 2));
    return ['ip', 'loc', 'http', 'tls'].filter((k) => fields[k]).map((k) => `${k}=${fields[k]}`).join(' ');
  }
  if (r.cobalt) {
    try {
      const info = JSON.parse(r.body).cobalt;
      return info ? `Cobalt v${info.version}` : 'не Cobalt API';
    } catch {
      return /just a moment|cloudflare/i.test(r.body) ? 'проверка браузера Cloudflare' : 'ответ не JSON';
    }
  }
  return '';
}

/** Checks outbound HTTP from Telegram's cloud. Admins only. */
export async function diag(message) {
  if (!config.adminIds.includes(message.from.id)) return say(message.chat.id, texts.ADMIN_ONLY);
  const targets = [
    ...config.diagUrls.map((url) => ({ url, label: url.replace(/^https?:\/\//, '') })),
    ...config.cobaltInstances.map((i) => ({
      url: `${i.url}/`,
      label: `Cobalt ${i.label}`,
      cobalt: true,
      headers: { Accept: 'application/json', ...(i.apiKey ? { Authorization: `Api-Key ${i.apiKey}` } : {}) },
    })),
  ];
  const results = await Promise.all(targets.map(probeUrl));
  const lines = ['<b>Запросы из облака Telegram</b>'];
  for (const r of results) {
    const head = `${r.ok ? '✅' : '❌'} <code>${escapeHtml(r.label)}</code>`;
    if (!r.ok) {
      lines.push(`${head}\n   ${escapeHtml(r.error)} · ${r.ms} мс`);
      continue;
    }
    const extra = [`HTTP ${r.status}`, `${r.ms} мс`, r.server, diagDetails(r)].filter(Boolean).join(' · ');
    lines.push(`${head}\n   ${escapeHtml(extra)}`);
  }
  await say(message.chat.id, lines.join('\n'));
}
