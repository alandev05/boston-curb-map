import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mockReqRes, mockFetch } from "./helpers.js";
import submit, { DAILY_LIMIT } from "../api/submit.js";
import curb from "../api/curb.js";
import confirm from "../api/confirm.js";
import review from "../api/review.js";
import { cardToPolicy, newCard } from "../src/submission.js";

const realFetch = globalThis.fetch;
const ZONE = "11111111-1111-4111-8111-111111111111", DEVICE = "22222222-2222-4222-8222-222222222222", SUB = "33333333-3333-4333-8333-333333333333";
beforeEach(() => { Object.assign(process.env, { SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sk", ADMIN_TOKEN: "letmein" }); delete process.env.DEPLOY_HOOK_URL; });
afterEach(() => { globalThis.fetch = realFetch; });

const post = (body, headers = {}) => { const { req, res } = mockReqRes(); req.method = "POST"; req.body = body; req.headers = headers; return { req, res }; };
const get = (query, headers = {}) => { const { req, res } = mockReqRes(query); req.method = "GET"; req.headers = headers; return { req, res }; };
// A tiny PostgREST stand-in: records writes, answers reads from `tables`.
function fakeDb(tables = {}, { count = 0 } = {}) {
  const writes = [];
  const f = mockFetch([{ match: () => true, respond: (url, init) => {
    const table = url.pathname.split("/").pop(), method = init.method || "GET";
    if (method !== "GET") { writes.push({ table, method, body: init.body ? JSON.parse(init.body) : null, query: url.search }); return { status: 201, body: null }; }
    return { body: tables[table] || [], headers: { "content-range": `0-0/${count}` } };
  } }]);
  return { f, writes };
}
const correction = (extra = {}) => ({ kind: "correction", curb_zone_id: ZONE, device_id: DEVICE, rules: [cardToPolicy(newCard("paid"), "0")], ...extra });

describe("POST /api/submit", () => {
  it("stores a correction and logs an event", async () => {
    const { writes } = fakeDb();
    const { req, res } = post(correction({ stretch: [10, 40], point: [-71.08, 42.35], note: "2 hr except Sunday" }));
    await submit(req, res);
    expect(res.statusCode).toBe(201);
    const row = writes.find((w) => w.table === "submissions" && w.method === "POST").body;
    expect(row).toMatchObject({ kind: "correction", curb_zone_id: ZONE, stretch_from: 10, stretch_to: 40, curb_lng: -71.08, note: "2 hr except Sunday" });
    expect(row.rules[0].rules[0].activity).toBe("parking");
    expect(writes.find((w) => w.table === "events").body).toMatchObject({ action: "submitted", curb_zone_id: ZONE });
  });
  it("rejects bad input before touching the database", async () => {
    const { f } = fakeDb();
    for (const bad of [correction({ kind: "vandalize" }), correction({ curb_zone_id: "x" }), correction({ device_id: "" }), correction({ rules: [] }), correction({ stretch: [40, 10] }), correction({ photo: "data:image/png;base64,AAAA" })]) {
      const { req, res } = post(bad);
      await submit(req, res);
      expect(res.statusCode).toBe(400);
    }
    expect(f.calls.filter((c) => (c.init.method || "GET") !== "GET")).toHaveLength(0);
  });
  it("rate-limits a device", async () => {
    fakeDb({}, { count: DAILY_LIMIT });
    const { req, res } = post(correction());
    await submit(req, res);
    expect(res.statusCode).toBe(429);
  });
  it("a newer correction from the same device supersedes their pending one", async () => {
    const { writes } = fakeDb({ submissions: [{ id: SUB }] });
    const { req, res } = post(correction());
    await submit(req, res);
    expect(writes.find((w) => w.method === "PATCH")).toMatchObject({ body: { status: "superseded" } });
  });
  it("says so when the backend isn't configured", async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    const { req, res } = post(correction());
    await submit(req, res);
    expect(res.statusCode).toBe(503);
  });
});

describe("GET /api/curb", () => {
  it("lists pending corrections with agreement counts, marking the caller's own", async () => {
    fakeDb({ submissions: [
      { id: SUB, kind: "correction", status: "pending", device_id: DEVICE, rules: [], confirmations: [{ count: 2 }], stretch_from: null },
      { id: "x", kind: "confirm", status: "pending", device_id: "other", confirmations: [{ count: 0 }] },
    ] });
    const { req, res } = get({ zone: ZONE, device: DEVICE });
    await curb(req, res);
    expect(res.json.pending).toEqual([expect.objectContaining({ id: SUB, confirmations: 2, mine: true, stretch: null })]);
    expect(res.json.confirms).toBe(1);
    expect(JSON.stringify(res.json)).not.toContain("other"); // no one else's device id
  });
});

describe("POST /api/confirm", () => {
  it("can't confirm your own correction", async () => {
    fakeDb({ submissions: [{ id: SUB, status: "pending", device_id: DEVICE, curb_zone_id: ZONE }] });
    const { req, res } = post({ submission_id: SUB, device_id: DEVICE });
    await confirm(req, res);
    expect(res.statusCode).toBe(400);
  });
  it("records someone else's agreement", async () => {
    const { writes } = fakeDb({ submissions: [{ id: SUB, status: "pending", device_id: "44444444-4444-4444-8444-444444444444", curb_zone_id: ZONE }] });
    const { req, res } = post({ submission_id: SUB, device_id: DEVICE });
    await confirm(req, res);
    expect(res.statusCode).toBe(200);
    expect(writes.map((w) => w.table)).toEqual(["confirmations", "events"]);
  });
});

describe("/api/review", () => {
  it("needs the admin token, and says which problem it is", async () => {
    fakeDb();
    let { req, res } = get({}, { "x-admin-token": "wrong-token" });
    await review(req, res);
    expect([res.statusCode, res.json.error]).toEqual([401, "wrong admin token"]);
    ({ req, res } = get({}, { "x-admin-token": "letmein\n" })); // stray whitespace is ignored
    await review(req, res);
    expect(res.statusCode).toBe(200);
    delete process.env.ADMIN_TOKEN;
    ({ req, res } = get({}, { "x-admin-token": "letmein" }));
    await review(req, res);
    expect(res.statusCode).toBe(503);
  });
  it("accepting supersedes earlier accepted corrections that overlap", async () => {
    const { writes } = fakeDb({ submissions: [{ id: SUB, kind: "correction", status: "pending", curb_zone_id: ZONE, stretch_from: null, stretch_to: null }] });
    const { req, res } = post({ id: SUB, decision: "accept", reviewer: "Alan" }, { "x-admin-token": "letmein" });
    await review(req, res);
    expect(res.statusCode).toBe(200);
    expect(writes.filter((w) => w.method === "PATCH").map((w) => w.body.status)).toContain("accepted");
    expect(writes.find((w) => w.table === "events").body).toMatchObject({ action: "accepted", actor: "reviewer:Alan" });
  });
});
