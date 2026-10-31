import { send, fail } from "./_cds.js";

// GET /api/meters -> GeoJSON points of Boston parking meters from Analyze Boston (CKAN).
// The resource id is discovered at runtime so the route survives dataset re-uploads.
const CKAN = "https://data.boston.gov/api/3/action";

async function ckan(action, params) {
  const url = new URL(`${CKAN}/${action}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`CKAN ${r.status} ${action}`);
  const js = await r.json();
  if (!js.success) throw new Error(`CKAN ${action} failed`);
  return js.result;
}

function pick(row, names) {
  for (const n of names) {
    for (const k of Object.keys(row)) if (k.toLowerCase() === n) {
      const v = parseFloat(row[k]);
      if (!Number.isNaN(v)) return v;
    }
  }
  return null;
}

export default async function handler(req, res) {
  try {
    const search = await ckan("package_search", { q: "parking meters", rows: 10 });
    let resource;
    for (const pkg of search.results || []) {
      if (!/parking.?meter/i.test(pkg.title || pkg.name)) continue;
      resource = (pkg.resources || []).find((r) => r.datastore_active) || resource;
      if (resource) break;
    }
    if (!resource) throw new Error("No datastore-backed parking meter resource found on data.boston.gov");

    const features = [];
    for (let offset = 0; offset < 50000; offset += 10000) {
      const page = await ckan("datastore_search", { resource_id: resource.id, limit: 10000, offset });
      for (const row of page.records || []) {
        const lng = pick(row, ["longitude", "long", "lon", "x"]);
        const lat = pick(row, ["latitude", "lat", "y"]);
        if (lng == null || lat == null || Math.abs(lat) > 90) continue;
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: row });
      }
      if ((page.records || []).length < 10000) break;
    }
    send(res, { type: "FeatureCollection", features, meta: { resource: resource.id, name: resource.name } }, 86400);
  } catch (e) { fail(res, e); }
}
