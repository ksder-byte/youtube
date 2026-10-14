// A test double of the platform's fetch: real HTTP (to local test servers)
// with the SDK's response shape — headers.get, text/json, async-iterable body.

export async function fetch(url, init = {}) {
  const res = await globalThis.fetch(url, init);
  return {
    status: res.status,
    statusText: res.statusText,
    ok: res.ok,
    url: res.url,
    headers: {
      get: (name) => res.headers.get(name),
      has: (name) => res.headers.has(name),
      keys: () => res.headers.keys(),
      entries: () => res.headers.entries(),
    },
    json: () => res.json(),
    text: () => res.text(),
    body: {
      async *[Symbol.asyncIterator]() {
        if (!res.body) return;
        for await (const chunk of res.body) yield chunk;
      },
    },
  };
}

fetch.body = {
  json: (value) => JSON.stringify(value),
  text: (value) => String(value),
  form: (value) => new URLSearchParams(value).toString(),
};
