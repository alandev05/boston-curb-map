import { cdsGet, unwrap, send, fail } from "./_cds.js";

// GET /api/zones?bbox=min_lng,min_lat,max_lng,max_lat
// Returns a GeoJSON FeatureCollection of CDS curb zones with geometry.
export default async function handler(req, res) {
  try {
    const bbox = (req.query.bbox || "").split(",").map(Number);
    if (bbox.length !== 4 || bbox.some(Number.isNaN)) return fail(res, "bbox=min_lng,min_lat,max_lng,max_lat required", 400);
    const [min_lng, min_lat, max_lng, max_lat] = bbox;

    const features = [];
    let meta = {};
    // Paginate defensively; most deployments return everything in one shot.
    for (let offset = 0, page = 0; page < 20; page++, offset += 500) {
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
    send(res, { type: "FeatureCollection", features, meta }, 1800);
  } catch (e) { fail(res, e); }
}
