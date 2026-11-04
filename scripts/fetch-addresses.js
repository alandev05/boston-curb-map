#!/usr/bin/env node
// Every address point in Boston, from the City's Street Address Management (SAM) list (Analyze Boston), for telling
// which side of a street has odd house numbers (street sweeping is posted by odd/even side). OpenStreetMap's house
// numbers are sparse; this list has ~400k points, each with its street's name.
// Writes data/raw/addresses.json: [[lng, lat, number, "street name"], …] (primary addresses only).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "data", "raw", "addresses.json");
const LAYER = process.env.SAM_LAYER || "https://gisportal.boston.gov/arcgis/rest/services/SAM/Live_SAM_Address/FeatureServer/0";
const PAGE = 2000, PARALLEL = 6, UA = "boston-curb-map (+https://github.com/alandev05/boston-curb-map)";

const getJSON = async (url) => {
  for (let tries = 0; ; tries++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(`${r.status}`);
      const js = await r.json();
      if (js.error) throw new Error(js.error.message || "ArcGIS error");
      return js;
    } catch (e) { if (tries >= 3) throw e; await new Promise((r) => setTimeout(r, 1000 * (tries + 1))); }
  }
};
const t0 = Date.now();
const where = encodeURIComponent("RELATIONSHIP_TYPE=1");
const { count } = await getJSON(`${LAYER}/query?where=${where}&returnCountOnly=true&f=json`);
const pages = Array.from({ length: Math.ceil(count / PAGE) }, (_, i) => i * PAGE), rows = [];
for (let i = 0; i < pages.length; i += PARALLEL) {
  const batch = await Promise.all(pages.slice(i, i + PARALLEL).map((off) =>
    getJSON(`${LAYER}/query?where=${where}&outFields=STREET_NUMBER_SORT,FULL_STREET_NAME&outSR=4326&orderByFields=OBJECTID&resultOffset=${off}&resultRecordCount=${PAGE}&f=json`)));
  for (const js of batch) for (const f of js.features || []) {
    const n = f.attributes.STREET_NUMBER_SORT, s = f.attributes.FULL_STREET_NAME, g = f.geometry;
    if (Number.isFinite(n) && n > 0 && s && g) rows.push([+g.x.toFixed(6), +g.y.toFixed(6), n, s]);
  }
}
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(rows));
console.log(`fetched ${rows.length} of ${count} addresses in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
