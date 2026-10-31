#!/usr/bin/env node
// Turn data/raw/{zones.geojson,policies.json} into static, gzipped vector tiles + a policies bundle:
//   public/tiles/{z}/{x}/{y}.pbf   z9–15 (overzoomed to 20 by the client)
//   public/data/policies.json       compact policy map for popups
//   public/data/manifest.json       counts, timestamps, bbox, zoom range
// Each feature carries a precomputed weekly schedule (`sched`, 168 chars) at detail zooms and
// only the dominant category (`dom`) at overview zooms, so the city-scale tiles stay tiny.
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import { encodeSchedule, dominant } from "../src/schedule.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IN = process.env.DATA_DIR || path.join(root, "data", "raw");
const OUT = process.env.PUBLIC_DIR || path.join(root, "public");
export const MIN_ZOOM = 9, MAX_ZOOM = 15, DETAIL_ZOOM = 12; // sched carried from DETAIL_ZOOM up
export const METERS_ZOOM = 13; // meter points appear from here
const DETAIL_KEYS = ["id", "zone", "street", "side", "pids", "sched"];

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);

export function prepare(features, policies) {
  const out = [];
  for (const f of features) {
    if (!f.geometry) continue;
    const p = f.properties || {};
    const sched = encodeSchedule(p, policies);
    out.push({
      type: "Feature", geometry: f.geometry,
      properties: {
        id: p.curb_zone_id, zone: p.user_zone_id ?? "", street: p.street_name ?? "", side: p.street_side ?? "",
        pids: (p.curb_policy_ids || []).join(","), sched, dom: dominant(sched),
      },
    });
  }
  return out;
}

function bboxOf(features) {
  let a = 180, b = 90, c = -180, d = -90;
  const walk = (x) => (typeof x[0] === "number" ? ((a = Math.min(a, x[0])), (b = Math.min(b, x[1])), (c = Math.max(c, x[0])), (d = Math.max(d, x[1]))) : x.forEach(walk));
  for (const f of features) walk(f.geometry.coordinates);
  return [a, b, c, d];
}

export async function buildTiles(features, policies, { out = OUT, log = console.error, meta = {}, meters = [] } = {}) {
  const prepared = prepare(features, policies);
  const bbox = bboxOf(prepared);
  // Two indexes: full (detail zooms) and slim (overview zooms, props stripped to dom + id).
  const slim = prepared.map((f) => ({ ...f, properties: { id: f.properties.id, dom: f.properties.dom } }));
  const opts = { maxZoom: MAX_ZOOM, indexMaxZoom: MAX_ZOOM, indexMaxPoints: 0, tolerance: 3, extent: 4096, buffer: 64, lineMetrics: false };
  const full = geojsonvt({ type: "FeatureCollection", features: prepared }, opts);
  // tolerance 0: geojson-vt would otherwise cull curbs shorter than the tolerance at city scale, and
  // the whole point of the overview is that every curb shows as a dash. Each is ~2 points, so it stays cheap.
  const thin = geojsonvt({ type: "FeatureCollection", features: slim }, { ...opts, tolerance: 0 });
  const meterIdx = meters.length ? geojsonvt({ type: "FeatureCollection", features: meters }, { ...opts, tolerance: 0 }) : null;

  await rm(path.join(out, "tiles"), { recursive: true, force: true });
  let count = 0, bytes = 0;
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const index = z >= DETAIL_ZOOM ? full : thin;
    const x0 = lon2x(bbox[0], z), x1 = lon2x(bbox[2], z), y0 = lat2y(bbox[3], z), y1 = lat2y(bbox[1], z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const t = index.getTile(z, x, y);
      const m = meterIdx && z >= METERS_ZOOM ? meterIdx.getTile(z, x, y) : null;
      if ((!t || !t.features.length) && (!m || !m.features.length)) continue;
      const layers = {};
      if (t?.features.length) layers.curbs = t;
      if (m?.features.length) layers.meters = m;
      const buf = gzipSync(Buffer.from(vtpbf.fromGeojsonVt(layers, { version: 2 })), { level: 9 });
      await mkdir(path.join(out, "tiles", String(z), String(x)), { recursive: true });
      await writeFile(path.join(out, "tiles", String(z), String(x), `${y}.pbf`), buf);
      count++; bytes += buf.length;
    }
    log(`  z${z}: ${count} tiles so far, ${(bytes / 1024).toFixed(0)} KB`);
  }
  // Popup bundle: policies trimmed to what the UI reads.
  const slimPolicies = Object.fromEntries(Object.entries(policies).map(([id, p]) => [id, {
    curb_policy_id: id, priority: p.priority, rules: (p.rules || []).map((r) => ({ activity: r.activity, max_stay: r.max_stay, user_classes: r.user_classes, purposes: r.purposes, rate: r.rate || r.rates })), time_spans: p.time_spans,
  }]));
  await mkdir(path.join(out, "data"), { recursive: true });
  await writeFile(path.join(out, "data", "policies.json"), JSON.stringify(slimPolicies));
  const manifest = { ...meta, built_at: new Date().toISOString(), zones: prepared.length, policies: Object.keys(policies).length, meters: meters.length, meters_zoom: METERS_ZOOM, tiles: count, tile_bytes: bytes, bbox, minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM, detail_zoom: DETAIL_ZOOM, tile_url: "/tiles/{z}/{x}/{y}.pbf" };
  await writeFile(path.join(out, "data", "manifest.json"), JSON.stringify(manifest, null, 1));
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t = Date.now();
  const fc = JSON.parse(await readFile(path.join(IN, "zones.geojson"), "utf8"));
  const policies = JSON.parse(await readFile(path.join(IN, "policies.json"), "utf8"));
  const meta = JSON.parse(await readFile(path.join(IN, "meta.json"), "utf8").catch(() => "{}"));
  const meters = JSON.parse(await readFile(path.join(IN, "meters.geojson"), "utf8").catch(() => '{"features":[]}')).features;
  const m = await buildTiles(fc.features, policies, { meta, meters });
  console.log(`built ${m.tiles} tiles (${(m.tile_bytes / 1024).toFixed(0)} KB gz) for ${m.zones} zones + ${m.meters} meters in ${((Date.now() - t) / 1000).toFixed(1)}s → ${OUT}`);
}
