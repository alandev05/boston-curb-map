#!/usr/bin/env node
// Pull every curb zone + policy for Boston from the CDS Curbs API into data/raw/.
//   node scripts/fetch-cds.js                      # city API
//   CDS_BASE=http://localhost:4321 node scripts/fetch-cds.js   # mock
// Writes data/raw/zones.geojson, data/raw/policies.json, data/raw/meta.json. Never partial-writes.
import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.DATA_DIR || path.join(root, "data", "raw");
const BASE = process.env.CDS_BASE || "https://cds-curb-api.boston.gov";
const BBOX = (process.env.BBOX || "-71.1912,42.2279,-70.9860,42.3969").split(",").map(Number);
const TILE_DEG = Number(process.env.TILE_DEG || 0.02); // ~2 km squares
const RPS = Number(process.env.RPS || 4);
const ACCEPTS = ["application/vnd.cds+json;version=1.0", "application/json"];
const UA = "boston-curb-map/0.2 (+https://github.com/alandev05/boston-curb-map)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let accept = null;

async function get(p, params = {}) {
  const url = new URL(p, BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const a of accept ? [accept] : ACCEPTS) {
      const r = await fetch(url, { headers: { Accept: a, "User-Agent": UA } });
      if (r.ok) { accept = a; return r.json(); }
      if (r.status === 406 || r.status === 415) continue;
      if (r.status === 429 || r.status >= 500) { await sleep((Number(r.headers.get("Retry-After")) || 2 ** attempt) * 1000); break; }
      throw new Error(`${r.status} ${url.pathname}`);
    }
  }
  throw new Error(`gave up on ${url.pathname}`);
}
const unwrap = (js, k) => (Array.isArray(js?.data) ? js.data : js?.data?.[k] ?? js?.[k] ?? []);

export async function fetchAll({ log = console.error } = {}) {
  const zones = new Map(); let meta = {};
  const [a, b, c, d] = BBOX; let n = 0;
  for (let y = b; y < d; y += TILE_DEG) for (let x = a; x < c; x += TILE_DEG) {
    let offset = 0;
    for (;;) {
      const js = await get("/curbs/zones", { include_geometry: "true", min_lng: x, min_lat: y, max_lng: Math.min(x + TILE_DEG, c), max_lat: Math.min(y + TILE_DEG, d), limit: 500, offset });
      meta = { version: js.version, time_zone: js.time_zone, last_updated: js.last_updated };
      const page = unwrap(js, "zones");
      for (const z of page) { const f = z.type === "Feature" ? { ...z, properties: { ...z.properties } } : (({ geometry, ...properties }) => ({ type: "Feature", geometry, properties }))(z); zones.set(f.properties.curb_zone_id, f); }
      await sleep(1000 / RPS);
      if (page.length < 500) break; offset += 500;
    }
    if (++n % 10 === 0) log(`  tile ${n}: ${zones.size} zones`);
  }
  const ids = [...new Set([...zones.values()].flatMap((f) => f.properties.curb_policy_ids || []))];
  const policies = {};
  for (let i = 0; i < ids.length; i += 50) {
    const js = await get("/curbs/policies", { ids: ids.slice(i, i + 50).join(",") });
    for (const p of unwrap(js, "policies")) policies[p.curb_policy_id] = p;
    await sleep(1000 / RPS);
  }
  if (!Object.keys(policies).length) { const js = await get("/curbs/policies"); for (const p of unwrap(js, "policies")) policies[p.curb_policy_id] = p; }
  return { zones: [...zones.values()], policies, meta: { ...meta, fetched_at: new Date().toISOString(), source: BASE, bbox: BBOX } };
}

async function atomicWrite(file, text) { await writeFile(file + ".tmp", text); await rename(file + ".tmp", file); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t = Date.now();
  const { zones, policies, meta } = await fetchAll();
  await mkdir(OUT, { recursive: true });
  await atomicWrite(path.join(OUT, "zones.geojson"), JSON.stringify({ type: "FeatureCollection", features: zones }));
  await atomicWrite(path.join(OUT, "policies.json"), JSON.stringify(policies));
  await atomicWrite(path.join(OUT, "meta.json"), JSON.stringify({ ...meta, zones: zones.length, policies: Object.keys(policies).length }, null, 1));
  console.log(`fetched ${zones.length} zones, ${Object.keys(policies).length} policies from ${BASE} in ${((Date.now() - t) / 1000).toFixed(1)}s → ${OUT}`);
}
