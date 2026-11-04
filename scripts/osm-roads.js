#!/usr/bin/env node
// Road centerlines from the same OpenFreeMap vector tiles the basemap draws (z14, the max native zoom),
// cached under data/raw/osm/ so `npm run data:offline` can re-snap without the network.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";

export const ROAD_ZOOM = 14;
// Curbs never run along these; driveways and parking aisles would steal curbs from the street they face.
const SKIP_CLASS = /^(path|track|rail|transit|ferry|raceway|bus_guideway|aerialway)/;
const SKIP_SERVICE = new Set(["driveway", "parking_aisle"]);

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);

export function decodeRoads(buf, x, y, z = ROAD_ZOOM) {
  if (buf[0] === 0x1f) buf = gunzipSync(buf);
  const layer = new VectorTile(new Pbf(buf)).layers.transportation;
  const roads = [];
  for (let i = 0; i < (layer?.length || 0); i++) {
    const f = layer.feature(i);
    const { class: cls, service } = f.properties;
    // Tunnels are drawn faintly and no curb runs along one (I-93, the Big Dig ramps), so they never take a curb.
    if (f.type !== 2 || SKIP_CLASS.test(cls) || SKIP_SERVICE.has(service) || f.properties.brunnel === "tunnel") continue;
    const g = f.toGeoJSON(x, y, z).geometry;
    for (const coords of g.type === "LineString" ? [g.coordinates] : g.coordinates) roads.push({ coords, cls: String(cls).replace(/_construction$/, "") });
  }
  return roads;
}

// Building footprints (outer rings, lon/lat) from the same tiles — used to keep curbs from being drawn through buildings.
export function decodeBuildings(buf, x, y, z = ROAD_ZOOM) {
  if (buf[0] === 0x1f) buf = gunzipSync(buf);
  const layer = new VectorTile(new Pbf(buf)).layers.building, out = [];
  for (let i = 0; i < (layer?.length || 0); i++) {
    const g = layer.feature(i).toGeoJSON(x, y, z).geometry;
    for (const poly of g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) out.push(poly[0]);
  }
  return out;
}

// Named street lines (for matching the city's street-sweeping table by street name) and house-number points
// (for telling a street's odd side from its even side).
export function decodeNames(buf, x, y, z = ROAD_ZOOM) {
  if (buf[0] === 0x1f) buf = gunzipSync(buf);
  const t = new VectorTile(new Pbf(buf)), names = [], numbers = [];
  const n = t.layers.transportation_name;
  for (let i = 0; i < (n?.length || 0); i++) {
    const f = n.feature(i), name = f.properties.name_en || f.properties.name;
    if (!name || f.type !== 2) continue;
    const g = f.toGeoJSON(x, y, z).geometry;
    for (const coords of g.type === "LineString" ? [g.coordinates] : g.coordinates) names.push({ name, coords });
  }
  // Neighborhood and place labels (point), for naming which stretch of a street a search result is.
  const places = [], pl = t.layers.place;
  for (let i = 0; i < (pl?.length || 0); i++) {
    const f = pl.feature(i), name = f.properties.name_en || f.properties.name;
    if (name && f.type === 1) places.push({ name, cls: f.properties.class, coord: f.toGeoJSON(x, y, z).geometry.coordinates });
  }
  const h = t.layers.housenumber;
  for (let i = 0; i < (h?.length || 0); i++) {
    const f = h.feature(i), num = parseInt(f.properties.housenumber, 10);
    if (!Number.isFinite(num)) continue;
    const g = f.toGeoJSON(x, y, z).geometry;
    numbers.push({ num, coord: g.type === "Point" ? g.coordinates : g.coordinates[0] });
  }
  return { names, numbers, places };
}

export async function loadRoads(bbox, opts = {}) {
  return (await loadOsm(bbox, opts)).roads;
}

// Roads, buildings, street names and house numbers for the bbox, from cache or OpenFreeMap.
export async function loadOsm(bbox, { cacheDir, offline = false, log = console.error } = {}) {
  await mkdir(cacheDir, { recursive: true });
  let tileUrl = null;
  const x0 = lon2x(bbox[0], ROAD_ZOOM), x1 = lon2x(bbox[2], ROAD_ZOOM), y0 = lat2y(bbox[3], ROAD_ZOOM), y1 = lat2y(bbox[1], ROAD_ZOOM);
  const roads = [], buildings = [], names = [], numbers = [], places = [];
  let fetched = 0, missing = 0;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const file = path.join(cacheDir, `${ROAD_ZOOM}-${x}-${y}.pbf`);
    let buf = await readFile(file).catch(() => null);
    if (!buf && !offline) {
      try {
        tileUrl ||= (await (await fetch("https://tiles.openfreemap.org/planet")).json()).tiles[0];
        const r = await fetch(tileUrl.replace("{z}", ROAD_ZOOM).replace("{x}", x).replace("{y}", y));
        if (r.ok) { buf = Buffer.from(await r.arrayBuffer()); await writeFile(file, buf); fetched++; }
      } catch (e) { log(`  osm tile ${x},${y}: ${e.message}`); }
    }
    if (!buf) { missing++; continue; }
    roads.push(...decodeRoads(buf, x, y));
    buildings.push(...decodeBuildings(buf, x, y));
    const nn = decodeNames(buf, x, y);
    names.push(...nn.names); numbers.push(...nn.numbers); places.push(...nn.places);
  }
  log(`  osm: ${roads.length} road lines, ${buildings.length} buildings from ${(x1 - x0 + 1) * (y1 - y0 + 1) - missing} tiles (${fetched} fetched, ${missing} unavailable)`);
  return { roads, buildings, names, numbers, places };
}
