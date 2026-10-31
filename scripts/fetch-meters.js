#!/usr/bin/env node
// Pull Boston parking meters from the City's ArcGIS Hub item (authoritative, maintained by BTD):
//   https://bostonopendata-boston.opendata.arcgis.com/datasets/parking-meters/api
// Hub's v3 API resolves the item to its FeatureServer layer URL; we page /query as GeoJSON.
// Writes data/raw/meters.geojson. Falls back to Analyze Boston CKAN if Hub is unavailable.
import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.DATA_DIR || path.join(root, "data", "raw");
export const HUB_ITEM = process.env.METERS_HUB_ITEM || "962da9bb739f440ba33e746661921244_9";
const HUB = process.env.HUB_BASE || "https://bostonopendata-boston.opendata.arcgis.com";
const CKAN = (process.env.CKAN_BASE || "https://data.boston.gov") + "/api/3/action";
const PAGE = 2000;
const UA = "boston-curb-map/0.2 (+https://github.com/alandev05/boston-curb-map)";

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${new URL(url).pathname}`);
  const js = await r.json();
  if (js.error) throw new Error(`ArcGIS: ${js.error.message || JSON.stringify(js.error)}`);
  return js;
}

// Keep the attributes the popup/analysis actually use; ArcGIS layers often carry 30+ fields.
const KEEP = /^(objectid|meter_id|meter|id|street|st_name|street_name|address|side|zone|zone_id|parkboston|pay_policy|rate|hours|hrs|time_limit|limit|type|status|vendor|blk|block|dist|district|beat|lat|lon|long|latitude|longitude)/i;
export function slimProps(p) {
  const out = {};
  for (const [k, v] of Object.entries(p || {})) if (KEEP.test(k) && v !== null && v !== "") out[k] = v;
  return out;
}

export async function fetchMetersHub({ log = console.error } = {}) {
  const meta = await getJSON(`${HUB}/api/v3/datasets/${HUB_ITEM}`);
  const layerUrl = meta?.data?.attributes?.url;
  if (!layerUrl) throw new Error("Hub item has no service url");
  log(`  layer: ${layerUrl} (${meta.data.attributes.recordCount ?? "?"} records)`);
  const features = [];
  for (let offset = 0; ; offset += PAGE) {
    const q = `${layerUrl}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson&resultRecordCount=${PAGE}&resultOffset=${offset}`;
    const js = await getJSON(q);
    for (const f of js.features || []) if (f.geometry?.type === "Point") features.push({ type: "Feature", geometry: f.geometry, properties: slimProps(f.properties) });
    if (!js.features?.length || js.features.length < PAGE || js.properties?.exceededTransferLimit === false) break;
  }
  return { features, source: layerUrl, fields: (meta.data.attributes.fields || []).map((f) => f.name) };
}

export async function fetchMetersCkan({ log = console.error } = {}) {
  const s = await getJSON(`${CKAN}/package_search?q=parking%20meters&rows=10`);
  let res;
  for (const pkg of s.result?.results || []) { if (!/parking.?meter/i.test(pkg.title || "")) continue; res = (pkg.resources || []).find((r) => r.datastore_active); if (res) break; }
  if (!res) throw new Error("no CKAN datastore resource");
  log(`  CKAN resource ${res.id}`);
  const features = [];
  for (let offset = 0; offset < 50000; offset += 10000) {
    const js = await getJSON(`${CKAN}/datastore_search?resource_id=${res.id}&limit=10000&offset=${offset}`);
    for (const row of js.result?.records || []) {
      const lng = parseFloat(row.LONGITUDE ?? row.longitude ?? row.X), lat = parseFloat(row.LATITUDE ?? row.latitude ?? row.Y);
      if (!(lat > 41.5 && lat < 43 && lng > -72 && lng < -70)) continue;
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: slimProps(row) });
    }
    if ((js.result?.records || []).length < 10000) break;
  }
  return { features, source: `ckan:${res.id}`, fields: [] };
}

export async function fetchMeters(opts) {
  try { return await fetchMetersHub(opts); }
  catch (e) { (opts?.log || console.error)(`  Hub failed (${e.message}); trying CKAN`); return fetchMetersCkan(opts); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t = Date.now();
  const { features, source } = await fetchMeters();
  await mkdir(OUT, { recursive: true });
  const file = path.join(OUT, "meters.geojson");
  await writeFile(file + ".tmp", JSON.stringify({ type: "FeatureCollection", features, meta: { source, fetched_at: new Date().toISOString() } }));
  await rename(file + ".tmp", file);
  console.log(`fetched ${features.length} meters from ${source} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
