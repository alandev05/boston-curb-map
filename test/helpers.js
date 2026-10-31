import { vi } from "vitest";

// Minimal Vercel-style req/res pair.
export function mockReqRes(query = {}) {
  const res = {
    headers: {}, statusCode: 200, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
    get json() { return JSON.parse(this.body); },
  };
  return { req: { query }, res };
}

// Route-table fetch mock. routes: [{ match: (url, init) => bool, respond: (url, init) => {status, body, headers} }]
export function mockFetch(routes) {
  const calls = [];
  const fn = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const r of routes) {
      if (r.match(url, init)) {
        const out = typeof r.respond === "function" ? r.respond(url, init) : r.respond;
        const status = out.status ?? 200;
        return {
          ok: status >= 200 && status < 300, status,
          headers: { get: (k) => (out.headers || {})[k] },
          json: async () => out.body,
          text: async () => JSON.stringify(out.body),
        };
      }
    }
    return { ok: false, status: 404, headers: { get: () => undefined }, json: async () => ({}), text: async () => "" };
  });
  fn.calls = calls;
  globalThis.fetch = fn;
  return fn;
}

export const cdsEnvelope = (key, items, extra = {}) => ({
  version: "1.0", time_zone: "America/New_York", last_updated: 1761890400000, data: { [key]: items }, ...extra,
});
