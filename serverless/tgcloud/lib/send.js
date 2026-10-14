// Sending downloaded bytes to a chat as the right kind of message.

import { api, InputFile } from 'sdk';
import { kindOf, mimeOf } from './download.js';
import { withRetry } from './telegram.js';

const PHOTO_LIMIT = 10 * 1024 * 1024;

/** "Artist - Title.mp3" -> { performer: 'Artist', title: 'Title' } */
export function audioTags(name) {
  const stem = String(name ?? '').replace(/\.[a-z0-9]{1,5}$/i, '').trim();
  const dash = stem.indexOf(' - ');
  if (dash > 0) return { performer: stem.slice(0, dash).trim(), title: stem.slice(dash + 3).trim() };
  return { title: stem || undefined };
}

function input(file) {
  return new InputFile(file.bytes, file.name, { type: file.type || mimeOf(file.name) });
}

/** Sends one file; `forceAudio` for the audio mode, whatever the extension says. */
export async function sendFile(chatId, file, { forceAudio = false, caption } = {}) {
  let kind = forceAudio ? 'audio' : kindOf(file.name, file.type);
  if (kind === 'photo' && file.size > PHOTO_LIMIT) kind = 'document';
  const base = { chat_id: chatId, ...(caption ? { caption, parse_mode: 'HTML' } : {}) };

  switch (kind) {
    case 'video':
      api.sendChatAction({ chat_id: chatId, action: 'upload_video' }).catch(() => {});
      return withRetry(() => api.sendVideo({ ...base, video: input(file), supports_streaming: true }));
    case 'audio':
      api.sendChatAction({ chat_id: chatId, action: 'upload_document' }).catch(() => {});
      return withRetry(() => api.sendAudio({ ...base, audio: input(file), ...audioTags(file.name) }));
    case 'photo':
      api.sendChatAction({ chat_id: chatId, action: 'upload_photo' }).catch(() => {});
      return withRetry(() => api.sendPhoto({ ...base, photo: input(file) }));
    case 'animation':
      return withRetry(() => api.sendAnimation({ ...base, animation: input(file) }));
    default:
      api.sendChatAction({ chat_id: chatId, action: 'upload_document' }).catch(() => {});
      return withRetry(() => api.sendDocument({ ...base, document: input(file) }));
  }
}

/** An album of up to 10 photos/videos; a single item goes as a normal message. */
export async function sendAlbum(chatId, files) {
  if (files.length === 1) return sendFile(chatId, files[0]);
  const media = files.map((file) => {
    let kind = kindOf(file.name, file.type);
    if (kind === 'photo' && file.size > PHOTO_LIMIT) kind = 'document';
    return { type: kind === 'video' || kind === 'photo' ? kind : 'document', media: input(file) };
  });
  // An album cannot mix documents with photos and videos: send those apart.
  const visual = media.filter((m) => m.type !== 'document');
  const docs = media.filter((m) => m.type === 'document');
  if (visual.length > 1) await withRetry(() => api.sendMediaGroup({ chat_id: chatId, media: visual }));
  else if (visual.length === 1) await sendFile(chatId, files[media.indexOf(visual[0])]);
  if (docs.length > 1) await withRetry(() => api.sendMediaGroup({ chat_id: chatId, media: docs }));
  else if (docs.length === 1) await sendFile(chatId, files[media.indexOf(docs[0])]);
}
