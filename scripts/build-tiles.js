#!/usr/bin/env node
// Turn data/raw/{zones.geojson,policies.json} into static, gzipped vector tiles + a policies bundle:
//   public/tiles/{z}/{x}/{y}.pbf   z9–15 (overzoomed to 20 by the client)
//   public/data/policies.json       compact policy map for popups
//   public/data/rulesets.json       every distinct set of rule ids, indexed by a feature's `rs`
//   public/data/manifest.json       counts, timestamps, bbox, zoom range
// Each feature carries `rs`, the index of its set of rule ids: the map grades each rule set once for the chosen
// time and stay and colors tiles by looking `rs` up in the result, so nothing per curb is computed while zooming.
// `dom` (the most common category over the week) is a fallback for a feature the browser hasn't graded.
// Level of detail: zoomed out, individual curbs are too small to read or click, so curb tiles start at MIN_ZOOM,
// where curbs fade in (CURB_FADE_ZOOM, basemap.js).
// Every data URL carries the build's version, so a browser never mixes tiles from one build with rules from another.
// Curbs are snapped onto the basemap's OSM centerlines first (scripts/snap.js): `side` (+1/-1, 0 = unsnapped)
// and `rc` (road class) let the map offset each one to its edge of the drawn road; `len` (m) drives
// zoom-based disclosure (short hydrant/corner stubs only appear at street zooms).
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import { encodeSchedule, dominant } from "../src/schedule.js";
import { snapZones, lineLength } from "./snap.js";
import { CURB_FADE_ZOOM, NO_DATA_ZOOM } from "../src/basemap.js";
import { isRealPolicy, reasonOf, categorize } from "../src/rules.js";
export { NO_DATA_ZOOM };
import { loadOsm } from "./osm-roads.js";
import { parseCsv, assignSweeping } from "./sweeping.js";
import { assignMeters } from "./meters.js";
import { applyCommunity } from "./community.js";
import { buildStreets } from "./streets.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IN = process.env.DATA_DIR || path.join(root, "data", "raw");
const OUT = process.env.PUBLIC_DIR || path.join(root, "public");
export const MIN_ZOOM = Math.floor(CURB_FADE_ZOOM), MAX_ZOOM = 15; // curbs fade in from CURB_FADE_ZOOM (basemap.js)
export const METERS_ZOOM = 13; // meter points appear from here

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);

// `rulesets` (in/out): distinct "id,id,…" strings; a feature's `rs` is its index here.
// Feature id → which city curb it is: [curb_zone_id, rs, length as the city drew it, from, to] (from/to in meters
// along that curb when community corrections cut it into pieces). Written in shards of CURB_SHARD features as
// public/data/curbs/<id / CURB_SHARD>.json; the map loads one when a curb is tapped.
export const CURB_SHARD = 2000;
export function prepare(features, policies, rulesets = [], curbs = []) {
  const out = [], index = new Map(rulesets.map((r, i) => [r, i]));
  for (const f of features) {
    if (!f.geometry) continue;
    const p = f.properties || {};
    const pids = (p.curb_policy_ids || []).join(",");
    if (!index.has(pids)) { index.set(pids, rulesets.length); rulesets.push(pids); }
    // The feature id is a small integer (the map keys hover/selection on it): the city's 36-character ids were
    // half of every tile and barely compress. The feed's street name, side and zone number are empty for every
    // curb, so they aren't carried.
    curbs.push([p.curb_zone_id ?? null, index.get(pids), p._rawLen ?? null, ...(p._from != null && !(p._from === 0 && p._to === p._rawLen) ? [p._from, p._to] : [])]);
    out.push({
      type: "Feature", id: out.length, geometry: f.geometry,
      properties: {
        rs: index.get(pids), dom: dominant(encodeSchedule(p, policies)),
        side: p._side ?? 0, rc: p._rc ?? "", len: /LineString/.test(f.geometry.type) ? Math.round(lineLength(f.geometry.coordinates)) : 999,
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

export async function buildTiles(features, policies, { out = OUT, log = console.error, meta = {}, meters = [], roads = null, buildings = null, names = null, numbers = null, places = null, addresses = null, sweeping = null, community = [] } = {}) {
  policies = { ...policies };
  // Placeholders the city's survey left where it couldn't read a sign ("Unusable Image", on ~38k curbs) aren't rules:
  // dropped here, so they're neither shipped nor splitting otherwise identical curbs into different rule sets.
  const junk = new Set(Object.keys(policies).filter((id) => !isRealPolicy(policies[id])));
  for (const id of junk) delete policies[id];
  if (junk.size) features = features.map((f) => (f.properties?.curb_policy_ids?.some((id) => junk.has(id)) ? { ...f, properties: { ...f.properties, curb_policy_ids: f.properties.curb_policy_ids.filter((id) => !junk.has(id)) } } : f));
  // Each curb's length as the city drew it: the editor measures stretches along it (scripts/community.js).
  const rawLen = (g) => (g?.type === "LineString" ? lineLength(g.coordinates) : g?.type === "MultiLineString" ? g.coordinates.reduce((n, c) => n + lineLength(c), 0) : null);
  features = features.map((f) => (rawLen(f.geometry) != null ? { ...f, properties: { ...f.properties, _rawLen: +rawLen(f.geometry).toFixed(1) } } : f));
  // Accepted community corrections first (they win on their stretch), then meters, both on the city's geometry.
  const comm = community.length ? applyCommunity(features, policies, community, { log }) : null;
  if (comm) features = comm.features;
  const metered = meters.length ? assignMeters(features, policies, meters, { log }) : null;
  if (metered) features = metered.features;
  // A curb a driver can use: any rule that isn't a ban (no stopping / no parking / travel lane).
  const usable = (f) => (f.properties?.curb_policy_ids || []).some((id) => policies[id] && !["no_stopping", "no_parking", "travel", "unknown"].includes(categorize(policies[id].rules?.[0] || {})));
  const snap = snapZones(features, roads, { buildings, usable });
  if (roads) log(`  snapped ${snap.snapped} of ${features.length} curbs onto road centerlines (${snap.stats.relaxed} on a second, looser pass, ${snap.stats.followed} by following a snapped neighbor); left in place: ${JSON.stringify(snap.stats.unsnapped)} (${snap.stats.clamped} pulled onto the nearest road edge); moved off another curb's edge (to their true position, or hidden if they have no rules): ${snap.stats.unstacked}; hidden inside intersections: ${snap.stats.hiddenInIntersection}; hidden (would cross a building, no road): ${snap.stats.hiddenThroughBuildings}; hidden (no parking, only drawable in the middle of a road): ${snap.stats.hiddenInRoad}`);
  // Street sweeping (city table, no geometry) joins onto the curbs as drawn; adds `sweep-*` policies.
  const sweep = sweeping?.length && names?.length ? assignSweeping(snap.features, policies, sweeping, { names, numbers, addresses }, { log }) : null;
  // Community pieces carry what the sign says, street cleaning included: no table-joined sweeping on top.
  for (const f of snap.features) if (f.properties?._community) f.properties.curb_policy_ids = f.properties.curb_policy_ids.filter((id) => !String(id).startsWith("sweep-"));
  const rulesets = [], curbs = [], prepared = prepare(snap.features, policies, rulesets, curbs);
  const bbox = bboxOf(prepared);
  // Two indexes, each carrying only the curbs drawn at its zooms: full (NO_DATA_ZOOM up: every curb) and ruled
  // (below that: curbs with at least one readable rule; the rest can only ever be "no data", hidden until NO_DATA_ZOOM).
  const ruledSet = new Set(rulesets.map((r, i) => (r.split(",").some((id) => isRealPolicy(policies[id])) ? i : -1)));
  const ruled = prepared.filter((f) => ruledSet.has(f.properties.rs));
  const opts = { maxZoom: MAX_ZOOM, indexMaxZoom: MAX_ZOOM, indexMaxPoints: 0, tolerance: 3, extent: 4096, buffer: 64, lineMetrics: false };
  const full = geojsonvt({ type: "FeatureCollection", features: prepared }, opts);
  const mid = geojsonvt({ type: "FeatureCollection", features: ruled }, opts);
  const meterIdx = meters.length ? geojsonvt({ type: "FeatureCollection", features: meters }, { ...opts, tolerance: 0 }) : null;

  await rm(path.join(out, "tiles"), { recursive: true, force: true });
  let count = 0, bytes = 0;
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const index = z >= NO_DATA_ZOOM ? full : mid;
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
    curb_policy_id: id, priority: p.priority, rules: (p.rules || []).map((r) => ({ activity: r.activity, max_stay: r.max_stay, max_stay_unit: r.max_stay_unit, user_classes: r.user_classes, user_classes_except: r.user_classes_except, purposes: r.purposes, rate: r.rate || r.rates })), rates: p.rates, time_spans: p.time_spans,
    ...(reasonOf(p) ? { reason: reasonOf(p) } : {}),
    ...(p.source ? { source: p.source } : {}), ...(p.submission_id ? { submission_id: p.submission_id } : {}),
  }]));
  await mkdir(path.join(out, "data"), { recursive: true });
  await writeFile(path.join(out, "data", "policies.json"), JSON.stringify(slimPolicies));
  await writeFile(path.join(out, "data", "rulesets.json"), JSON.stringify(rulesets));
  // Streets with curbs, for the search box's instant suggestions (scripts/streets.js).
  if (names?.length) {
    const streets = buildStreets(names, places || [], snap.features);
    await writeFile(path.join(out, "data", "streets.json"), JSON.stringify(streets));
    log(`  streets: ${streets.length} for search`);
  }
  await rm(path.join(out, "data", "curbs"), { recursive: true, force: true });
  await mkdir(path.join(out, "data", "curbs"), { recursive: true });
  for (let k = 0; k * CURB_SHARD < curbs.length; k++) await writeFile(path.join(out, "data", "curbs", `${k}.json`), JSON.stringify(curbs.slice(k * CURB_SHARD, (k + 1) * CURB_SHARD)));
  const built = new Date(), version = built.getTime().toString(36);
  const manifest = { ...meta, snapped: snap.snapped, sweeping: sweep ? { rows: sweep.rows, matched: sweep.rowsMatched, curbs: sweep.curbsSwept } : null, built_at: built.toISOString(), version, zones: prepared.length, rulesets: rulesets.length, policies: Object.keys(policies).length, meters: meters.length, meters_on_curbs: metered?.stats.matched ?? 0, community: comm?.stats.pieces ?? 0, curb_shard: CURB_SHARD, meters_zoom: METERS_ZOOM, tiles: count, tile_bytes: bytes, bbox, minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM, tile_url: `/tiles/{z}/{x}/{y}.pbf?v=${version}` };
  await writeFile(path.join(out, "data", "manifest.json"), JSON.stringify(manifest, null, 1));
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t = Date.now();
  const fc = JSON.parse(await readFile(path.join(IN, "zones.geojson"), "utf8"));
  const policies = JSON.parse(await readFile(path.join(IN, "policies.json"), "utf8"));
  const meta = JSON.parse(await readFile(path.join(IN, "meta.json"), "utf8").catch(() => "{}"));
  const meters = JSON.parse(await readFile(path.join(IN, "meters.geojson"), "utf8").catch(() => '{"features":[]}')).features;
  const community = JSON.parse(await readFile(path.join(IN, "submissions.json"), "utf8").catch(() => "[]"));
  const addresses = JSON.parse(await readFile(path.join(IN, "addresses.json"), "utf8").catch(() => "[]"));
  const offline = process.argv.includes("--offline") || process.env.DATA_OFFLINE === "1";
  const osm = process.env.NO_SNAP ? null : await loadOsm(bboxOf(fc.features.filter((f) => f.geometry)), { cacheDir: path.join(IN, "osm"), offline });
  const sweeping = parseCsv(await readFile(path.join(IN, "sweeping.csv"), "utf8").catch(() => ""));
  const m = await buildTiles(fc.features, policies, { meta, meters, roads: osm?.roads, buildings: osm?.buildings, names: osm?.names, numbers: osm?.numbers, places: osm?.places, sweeping, community, addresses });
  console.log(`built ${m.tiles} tiles (${(m.tile_bytes / 1024).toFixed(0)} KB gz) for ${m.zones} zones + ${m.meters} meters in ${((Date.now() - t) / 1000).toFixed(1)}s → ${OUT}`);
}
