import { cdsGet, unwrap, send, fail } from "./_cds.js";

// GET /api/zones?bbox=min_lng,min_lat,max_lng,max_lat[&lite=1]
// Returns a GeoJSON FeatureCollection of CDS curb zones with geometry.
// lite=1 keeps only the fields the citywide overview needs and rounds coords to 5 dp (~1 m),
// so a whole-Boston response stays small enough to cache at the edge.
const LITE_KEYS = ["curb_zone_id", "user_zone_id", "street_name", "street_side", "curb_policy_ids"];
const round5 = (n) => Math.round(n * 1e5) / 1e5;
function roundGeom(g) {
  if (!g) return g;
  const rec = (c) => (typeof c[0] === "number" ? c.map(round5) : c.map(rec));
  return { ...g, coordinates: rec(g.coordinates) };
}
export function liteFeature(f) {
  const properties = {};
  for (const k of LITE_KEYS) if (f.properties[k] !== undefined) properties[k] = f.properties[k];
  return { type: "Feature", id: f.id, geometry: roundGeom(f.geometry), properties };
}
export default async function handler(req, res) {
  try {
    const bbox = (req.query.bbox || "").split(",").map(Number);
    if (bbox.length !== 4 || bbox.some(Number.isNaN)) return fail(res, "bbox=min_lng,min_lat,max_lng,max_lat required", 400);
    const [min_lng, min_lat, max_lng, max_lat] = bbox;
    const lite = req.query.lite === "1" || req.query.lite === "true";

    const features = [];
    let meta = {};
    // Paginate defensively; most deployments return everything in one shot.
    for (let offset = 0, page = 0; page < 400; page++, offset += 500) {
      const js = await cdsGet("/curbs/zones", {
        include_geometry: "true", min_lng, min_lat, max_lng, max_lat, limit: 500, offset,
      });
      meta = { version: js.version, last_updated: js.last_updated, time_zone: js.time_zone };
      const zones = unwrap(js, "zones");
      for (const z of zones) {
        if (z.type === "Feature") { features.push(z); continue; }
        const { geometry, ...properties } = z;
        features.push({ type: "Feature", geometry, properties });
      }
      if (zones.length < 500) break;
    }
    const out = lite ? features.map(liteFeature) : features;
    send(res, { type: "FeatureCollection", features: out, meta }, lite ? 21600 : 1800);
  } catch (e) { fail(res, e); }
}
