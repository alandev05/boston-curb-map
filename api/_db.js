// Supabase access for the submission endpoints. Server-side only: the secret key never reaches the browser, and every
// table has row-level security with no policies, so the publishable key can't read or write them either.
import { createHash, timingSafeEqual } from "node:crypto";

const env = (k) => {
  const v = process.env[k];
  if (!v) throw Object.assign(new Error(`${k} is not set`), { status: 503 });
  return v;
};
const headers = (extra = {}) => ({ apikey: env("SUPABASE_SECRET_KEY"), Authorization: `Bearer ${env("SUPABASE_SECRET_KEY")}`, ...extra });

// PostgREST: db("submissions?select=*&id=eq.…"), db("events", { method: "POST", body: {...} }).
export async function db(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/${path}`, {
    method, headers: headers({ "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`database: ${r.status} ${text.slice(0, 200)}`), { status: 502 });
  return { data: text ? JSON.parse(text) : null, count: Number(r.headers.get("content-range")?.split("/")[1]) || 0 };
}

export const BUCKET = "evidence";
export async function putPhoto(path, buf) {
  const r = await fetch(`${env("SUPABASE_URL")}/storage/v1/object/${BUCKET}/${path}`, { method: "POST", headers: headers({ "Content-Type": "image/jpeg", "x-upsert": "false" }), body: buf });
  if (!r.ok) throw Object.assign(new Error(`photo upload: ${r.status} ${(await r.text()).slice(0, 200)}`), { status: 502 });
}
export async function photoUrl(path, expiresIn = 3600) {
  const r = await fetch(`${env("SUPABASE_URL")}/storage/v1/object/sign/${BUCKET}/${path}`, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify({ expiresIn }) });
  if (!r.ok) return null;
  const { signedURL } = await r.json();
  return signedURL ? `${env("SUPABASE_URL")}/storage/v1${signedURL}` : null;
}

// Vercel parses JSON bodies into req.body; the local dev server does the same (scripts/dev-server.js).
export const bodyOf = (req) => (req.body && typeof req.body === "object" ? req.body : (() => { try { return JSON.parse(req.body || "{}"); } catch { return {}; } })());

// Salted, one-way: enough to rate-limit and spot abuse without storing addresses.
export function ipHash(req) {
  const ip = String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  return ip ? createHash("sha256").update(`${process.env.IP_SALT || process.env.SUPABASE_URL}|${ip}`).digest("hex").slice(0, 32) : null;
}

export function isAdmin(req) {
  const want = process.env.ADMIN_TOKEN?.trim(), got = String(req.headers?.["x-admin-token"] || "").trim(); // a pasted value may carry a newline
  if (!want || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export function reply(res, status, body) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(body));
}
export const replyError = (res, e) => reply(res, e.status || 400, { error: String(e.message || e) });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const event = (actor, action, fields = {}) => db("events", { method: "POST", body: { actor, action, ...fields } });
