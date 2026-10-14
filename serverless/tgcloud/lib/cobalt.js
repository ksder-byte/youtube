// Client for the Cobalt API (v11) with instance failover.

import { fetch } from 'sdk';
import { config } from './config.js';
import { markInstance, unhealthyInstances } from './store.js';
import { sleep, withTimeout } from './util.js';

export const STATUS = {
  ERROR: 'error',
  PICKER: 'picker',
  REDIRECT: 'redirect',
  TUNNEL: 'tunnel',
  LOCAL_PROCESSING: 'local-processing',
};

// "This instance cannot do it" rather than "this link is bad": only these are
// worth retrying elsewhere. A private video stays private on every instance.
const FAILOVER_CODES = new Set([
  'error.api.youtube.no_session_tokens',
  'error.api.youtube.token_expired',
  'error.api.youtube.login',
  'error.api.youtube.decipher',
  'error.api.youtube.no_hls_streams',
  'error.api.youtube.codec',
  'error.api.fetch.fail',
  'error.api.fetch.critical',
  'error.api.fetch.rate',
  'error.api.service.disabled',
  'error.api.service.unsupported',
  'error.api.capacity',
  'error.api.rate_exceeded',
  'error.api.generic',
  'error.api.unknown',
]);

// How long an instance goes to the back of the line after refusing to talk.
const COOLDOWN = 300;

export function shouldFailover(code) {
  // error.api.auth.* means our key is wrong *for that instance*.
  return FAILOVER_CODES.has(code) || String(code).startsWith('error.api.auth.');
}

export class CobaltError extends Error {
  constructor(code, context = {}) {
    super(code);
    this.name = 'CobaltError';
    this.code = code;
    this.context = context ?? {};
  }
}

export class CobaltUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'CobaltUnavailable';
  }
}

function headers(instance) {
  const h = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (instance.apiKey) h.Authorization = `Api-Key ${instance.apiKey}`;
  return h;
}

export function parseResult(data, source = null) {
  const status = data?.status ?? '';
  if (status === STATUS.PICKER) {
    return {
      status,
      source,
      picker: (data.picker ?? [])
        .filter((item) => item?.url)
        .map((item) => ({ type: item.type ?? 'photo', url: item.url, thumb: item.thumb ?? null })),
      audio: typeof data.audio === 'string' ? data.audio : null,
      audioFilename: data.audioFilename ?? null,
    };
  }
  if (status === STATUS.LOCAL_PROCESSING) {
    const output = data.output ?? {};
    return {
      status,
      source,
      tunnels: (data.tunnel ?? []).filter(Boolean),
      filename: output.filename ?? null,
      type: output.type ?? null,
      service: data.service ?? null,
    };
  }
  return { status, source, url: data?.url ?? null, filename: data?.filename ?? null };
}

/** Healthy instances first; a cooling one is still better than giving up. */
async function ordered(instances) {
  let cooling;
  try {
    cooling = await unhealthyInstances();
  } catch {
    cooling = new Map();
  }
  return [...instances.filter((i) => !cooling.has(i.url)), ...instances.filter((i) => cooling.has(i.url))];
}

async function mark(instance, seconds, error) {
  try {
    await markInstance(instance.url, seconds, error);
  } catch (e) {
    console.warn('cannot record instance health', e?.message);
  }
}

async function post(instance, payload) {
  const res = await withTimeout(
    fetch(`${instance.url}/`, { method: 'POST', headers: headers(instance), body: JSON.stringify(payload) }),
    config.apiTimeoutMs,
  );
  const body = await res.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new CobaltUnavailable(`${instance.label} answered HTTP ${res.status} with non-JSON: ${body.slice(0, 120)}`);
  }
  if (!data || typeof data !== 'object') throw new CobaltUnavailable(`${instance.label} returned ${body.slice(0, 120)}`);
  return { data, httpStatus: res.status };
}

export function buildPayload(url, opts = {}) {
  const prefs = opts.prefs ?? config.defaults;
  return {
    url,
    downloadMode: opts.mode === 'a' ? 'audio' : 'auto',
    videoQuality: opts.quality && opts.quality !== '-' ? opts.quality : prefs.videoQuality,
    audioFormat: prefs.audioFormat,
    audioBitrate: prefs.audioBitrate,
    filenameStyle: 'basic',
    youtubeVideoCodec: prefs.codec,
    youtubeVideoContainer: 'mp4',
    // Off by default: the better track is often opus, which mp4 cannot hold,
    // and a failed transcode comes back as an empty file.
    youtubeBetterAudio: config.youtubeBetterAudio,
    disableMetadata: false,
    // Nothing here can mux tracks, so the instance has to.
    localProcessing: 'disabled',
    alwaysProxy: config.alwaysProxy,
  };
}

/**
 * Asks the instances in order. Throws CobaltError for a definite answer about
 * the link, CobaltUnavailable when no instance could deliver.
 */
export async function processUrl(url, opts = {}, instances = config.cobaltInstances) {
  if (!instances.length) throw new CobaltUnavailable('no Cobalt instance configured');
  const payload = buildPayload(url, opts);
  const list = await ordered(instances);
  // With a single instance there is nowhere to fail over to, so retry it once.
  const attempts = list.length === 1 ? 2 : 1;
  const transport = [];
  let last = null;

  for (const instance of list) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let data, httpStatus;
      try {
        ({ data, httpStatus } = await post(instance, payload));
      } catch (e) {
        transport.push(`${instance.label}: ${e.message}`);
        console.warn(`${instance.label} did not answer (${attempt}/${attempts}): ${e.message}`);
        await mark(instance, COOLDOWN, e.message);
        if (attempt < attempts) await sleep(1000);
        continue;
      }

      if (httpStatus === 429 || httpStatus >= 500) {
        transport.push(`${instance.label}: HTTP ${httpStatus}`);
        await mark(instance, COOLDOWN, `HTTP ${httpStatus}`);
        break;
      }

      if (data.status === STATUS.ERROR) {
        const code = data.error?.code ?? 'error.api.unknown';
        if (!shouldFailover(code)) throw new CobaltError(code, data.error?.context);
        last = new CobaltError(code, data.error?.context);
        if (code.startsWith('error.api.auth.') || code === 'error.api.capacity' || code === 'error.api.rate_exceeded') {
          await mark(instance, COOLDOWN, code);
        }
        break;
      }

      if (!data.status) {
        transport.push(`${instance.label}: response without status`);
        await mark(instance, COOLDOWN, 'response without status');
        break;
      }

      if (attempt > 1 || list[0] !== instance) console.info(`served ${url} via ${instance.label}`);
      await mark(instance, 0, null);
      return parseResult(data, instance.label);
    }
  }

  // Every instance refused for the same kind of reason: report it.
  if (last) throw last;
  throw new CobaltUnavailable(transport.join('; ') || 'no instance answered');
}

/** What one instance says about itself; never throws. Used by /status. */
export async function probe(instance) {
  const started = Date.now();
  try {
    const res = await withTimeout(fetch(`${instance.url}/`, { headers: headers(instance) }), 15_000);
    const body = await res.text();
    const latencyMs = Date.now() - started;
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      const lowered = body.slice(0, 300).toLowerCase();
      const error = lowered.includes('cloudflare') || lowered.includes('just a moment')
        ? 'Cloudflare показывает проверку браузера'
        : lowered.includes('<html') || lowered.includes('<!doctype')
          ? 'отдаёт HTML вместо JSON — это адрес сайта, а не API'
          : `HTTP ${res.status}: ответ не JSON`;
      return { instance, ok: false, error, latencyMs };
    }
    const info = data?.cobalt;
    if (!info || typeof info !== 'object') return { instance, ok: false, error: 'это JSON, но не Cobalt API', latencyMs };
    const services = Array.isArray(info.services) ? info.services : [];
    return { instance, ok: true, version: info.version ?? '?', services, youtube: services.includes('youtube'), latencyMs };
  } catch (e) {
    return { instance, ok: false, error: e.message };
  }
}

export function survey(instances = config.cobaltInstances) {
  return Promise.all(instances.map(probe));
}
