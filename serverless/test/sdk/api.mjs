// A test double of the platform's Bot API client: records calls, answers
// with plausible results, and lets a test script any method.

export class BotApiError extends Error {
  constructor(method, code, description, parameters = {}) {
    super(description);
    this.name = 'BotApiError';
    this.method = method;
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
}

export class InputFile {
  constructor(bytes, filename, options = {}) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.filename = filename;
    this.type = options.type ?? null;
  }
}

export const calls = [];
const handlers = new Map();
let nextMessageId = 100;

export function onApi(method, fn) {
  handlers.set(method, fn);
}

export function resetApi() {
  calls.length = 0;
  handlers.clear();
  nextMessageId = 100;
}

export function callsOf(method) {
  return calls.filter((c) => c.method === method).map((c) => c.params);
}

function defaults(method, params) {
  if (method === 'getMe') return { id: 999, is_bot: true, first_name: 'Test', username: 'test_bot' };
  if (method === 'getChatMember') return { status: 'member', user: { id: params.user_id } };
  if (method.startsWith('send') && method !== 'sendChatAction') {
    const message = { message_id: nextMessageId++, chat: { id: params.chat_id }, date: 1 };
    return method === 'sendMediaGroup' ? params.media.map(() => ({ ...message, message_id: nextMessageId++ })) : message;
  }
  return true;
}

export const api = new Proxy(
  {},
  {
    get(_, method) {
      if (typeof method !== 'string' || method === 'then') return undefined;
      return async (params = {}) => {
        calls.push({ method, params });
        const handler = handlers.get(method);
        return handler ? handler(params) : defaults(method, params);
      };
    },
  },
);
