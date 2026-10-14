// Everything the bot keeps in its database. Tables are declared in ../schema.js.

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { AUDIO_BITRATES, AUDIO_FORMATS, VIDEO_QUALITIES, YOUTUBE_CODECS, config } from './config.js';
import { now, randomToken } from './util.js';

const LINK_TTL = 24 * 3600;
// Longer than any run the platform allows; only a crashed run leaves a row behind.
const JOB_TTL = 15 * 60;
const HISTORY_KEEP = 50;

// ── users and their defaults ──────────────────────────────────────────────

export async function touchUser(user) {
  if (!user?.id) return;
  await db.run(sql`
    INSERT INTO users (id, first_name, username, lang)
    VALUES (${user.id}, ${user.first_name ?? null}, ${user.username ?? null}, ${user.language_code ?? null})
    ON CONFLICT (id) DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username,
      lang = excluded.lang,
      seen_at = unixepoch()`);
}

const PREF_COLUMNS = {
  videoQuality: { column: 'video_quality', allowed: VIDEO_QUALITIES },
  audioFormat: { column: 'audio_format', allowed: AUDIO_FORMATS },
  audioBitrate: { column: 'audio_bitrate', allowed: AUDIO_BITRATES },
  codec: { column: 'codec', allowed: YOUTUBE_CODECS },
};

/** The user's defaults, falling back to the bot's. */
export async function getPrefs(userId) {
  const row = userId
    ? await db.get(sql`SELECT video_quality, audio_format, audio_bitrate, codec FROM users WHERE id = ${userId}`)
    : null;
  const prefs = { ...config.defaults };
  for (const [key, { column, allowed }] of Object.entries(PREF_COLUMNS)) {
    const value = row?.[column];
    if (value && allowed.includes(value)) prefs[key] = value;
  }
  return prefs;
}

/** Saves whatever valid keys `changes` has; returns the resulting prefs. */
export async function savePrefs(userId, changes) {
  for (const [key, { column, allowed }] of Object.entries(PREF_COLUMNS)) {
    if (!(key in changes)) continue;
    const value = changes[key];
    if (!allowed.includes(value)) throw new RangeError(`bad value for ${key}`);
    // Column names come from the fixed table above, never from the caller.
    await db.run(
      `INSERT INTO users (id, ${column}) VALUES (:id, :value)
       ON CONFLICT (id) DO UPDATE SET ${column} = excluded.${column}`,
      { ':id': userId, ':value': value },
    );
  }
  return getPrefs(userId);
}

// ── link tokens ───────────────────────────────────────────────────────────

export async function putLink(url, userId) {
  await db.run(sql`DELETE FROM links WHERE created_at < ${now() - LINK_TTL}`);
  const token = randomToken(10);
  await db.run(sql`INSERT INTO links (token, url, user_id, created_at) VALUES (${token}, ${url}, ${userId}, ${now()})`);
  return token;
}

export async function getLink(token) {
  if (!token || typeof token !== 'string' || token.length > 32) return null;
  const row = await db.get(sql`SELECT url, user_id, created_at FROM links WHERE token = ${token}`);
  if (!row || row.created_at < now() - LINK_TTL) return null;
  return { url: row.url, userId: row.user_id };
}

// ── one job per user ──────────────────────────────────────────────────────

export async function acquireJob(userId) {
  await db.run(sql`DELETE FROM jobs WHERE user_id = ${userId} AND started_at < ${now() - JOB_TTL}`);
  const result = await db.run(sql`
    INSERT INTO jobs (user_id, started_at) VALUES (${userId}, ${now()})
    ON CONFLICT (user_id) DO NOTHING`);
  return result.rowsAffected === 1;
}

export async function releaseJob(userId) {
  await db.run(sql`DELETE FROM jobs WHERE user_id = ${userId}`);
}

// ── history ───────────────────────────────────────────────────────────────

export async function addHistory({ userId, url, mode, quality = null, status = 'started', via = 'bot' }) {
  const result = await db.run(sql`
    INSERT INTO downloads (user_id, url, mode, quality, status, via, created_at)
    VALUES (${userId}, ${url}, ${mode}, ${quality}, ${status}, ${via}, ${now()})
    RETURNING id`);
  // Keep the table small: a user sees the last few dozen anyway.
  await db.run(sql`
    DELETE FROM downloads WHERE user_id = ${userId} AND id NOT IN (
      SELECT id FROM downloads WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${HISTORY_KEEP})`);
  return result.rows?.[0]?.id ?? result.lastInsertRowid;
}

export async function updateHistory(id, { status, title, error, sizeBytes }) {
  if (!id) return;
  await db.run(sql`
    UPDATE downloads SET
      status = coalesce(${status ?? null}, status),
      title = coalesce(${title ?? null}, title),
      error = coalesce(${error ?? null}, error),
      size_bytes = coalesce(${sizeBytes ?? null}, size_bytes)
    WHERE id = ${id}`);
}

export async function listHistory(userId, limit = 30) {
  const rows = await db.all(sql`
    SELECT id, url, mode, quality, title, status, size_bytes, via, created_at
    FROM downloads WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${limit}`);
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    mode: r.mode,
    quality: r.quality,
    title: r.title,
    status: r.status,
    sizeBytes: r.size_bytes,
    via: r.via,
    createdAt: r.created_at,
  }));
}

export async function clearHistory(userId) {
  await db.run(sql`DELETE FROM downloads WHERE user_id = ${userId}`);
}

/** How many requests a user made in the last `seconds` (a simple rate limit). */
export async function recentRequests(userId, seconds) {
  const row = await db.get(sql`
    SELECT count(*) AS n FROM downloads WHERE user_id = ${userId} AND created_at >= ${now() - seconds}`);
  return row?.n ?? 0;
}

// ── Cobalt instance health ────────────────────────────────────────────────

export async function unhealthyInstances() {
  const rows = await db.all(sql`SELECT url, unhealthy_until FROM instance_health WHERE unhealthy_until > ${now()}`);
  return new Map(rows.map((r) => [r.url, r.unhealthy_until]));
}

export async function markInstance(url, seconds, error = null) {
  const until = seconds > 0 ? now() + seconds : 0;
  await db.run(sql`
    INSERT INTO instance_health (url, unhealthy_until, last_error) VALUES (${url}, ${until}, ${error})
    ON CONFLICT (url) DO UPDATE SET unhealthy_until = excluded.unhealthy_until,
      last_error = coalesce(excluded.last_error, instance_health.last_error)`);
}
