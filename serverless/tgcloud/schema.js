import { table, integer, text, index, sql } from 'sdk/db';

// Timestamps are plain unix seconds: lib/store.js talks raw SQL, and raw rows
// come back without mode conversion anyway.

// Everyone who talked to the bot, with their own defaults (null = the bot's).
export const users = table('users', {
  id:           integer('id').primaryKey(),
  firstName:    text('first_name'),
  username:     text('username'),
  lang:         text('lang'),
  videoQuality: text('video_quality'),
  audioFormat:  text('audio_format'),
  audioBitrate: text('audio_bitrate'),
  codec:        text('codec'),
  createdAt:    integer('created_at').notNull().default(sql`(unixepoch())`),
  seenAt:       integer('seen_at').notNull().default(sql`(unixepoch())`),
});

// callback_data is capped at 64 bytes, so buttons carry a token, not the URL.
export const links = table('links', {
  token:     text('token').primaryKey(),
  url:       text('url').notNull(),
  userId:    integer('user_id').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, (t) => ({
  createdIdx: index('idx_links_created').on(t.createdAt),
}));

// One running download per user; a stale row (crashed run) expires.
export const jobs = table('jobs', {
  userId:    integer('user_id').primaryKey(),
  startedAt: integer('started_at').notNull(),
});

// What each user downloaded: the Mini App's history tab.
export const downloads = table('downloads', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  userId:    integer('user_id').notNull(),
  url:       text('url').notNull(),
  mode:      text('mode').notNull(),   // v | a
  quality:   text('quality'),
  title:     text('title'),
  status:    text('status').notNull(), // started | sent | worker | link | too_large | error
  error:     text('error'),
  sizeBytes: integer('size_bytes'),
  via:       text('via').notNull().default('bot'), // bot | app
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, (t) => ({
  userIdx: index('idx_downloads_user').on(t.userId, t.createdAt),
}));

// Cobalt instances that failed recently are tried last for a while.
export const instanceHealth = table('instance_health', {
  url:            text('url').primaryKey(),
  unhealthyUntil: integer('unhealthy_until').notNull().default(0),
  lastError:      text('last_error'),
});
