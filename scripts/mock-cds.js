#!/usr/bin/env node
// Mock of cds-curb-api.boston.gov (+ a sliver of data.boston.gov CKAN) for offline dev/tests.
// Generates a deterministic grid of curb zones across Boston with realistic policy mixes.
//
//   node scripts/mock-cds.js --port 4321
//   CDS_BASE=http://localhost:4321 CKAN_BASE=http://localhost:4321 node scripts/dev-server.js
import http from "node:http";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : []).filter(Boolean));
const PORT = Number(args.port || 4321);
const STRICT_ACCEPT = args.strict === true || args.strict === "true"; // require CDS Accept header (406 otherwise)

export const POLICIES = {
  "pol-meter-2h": { curb_policy_id: "pol-meter-2h", priority: 10, published_date: "2026-01-01",
    rules: [{ activity: "parking", max_stay: 120, user_classes: ["car"], rate: [{ rate: 375, rate_unit: "hour" }] }],
    time_spans: [{ days_of_week: ["mon","tue","wed","thu","fri","sat"], time_of_day_start: "08:00", time_of_day_end: "20:00" }] },
  "pol-meter-30m": { curb_policy_id: "pol-meter-30m", priority: 10,
    rules: [{ activity: "parking", max_stay: 30, user_classes: ["car"], rate: [{ rate: 375, rate_unit: "hour" }] }],
    time_spans: [{ days_of_week: ["mon","tue","wed","thu","fri","sat"], time_of_day_start: "08:00", time_of_day_end: "18:00" }] },
  "pol-rpp": { curb_policy_id: "pol-rpp", priority: 20,
    rules: [{ activity: "parking", user_classes: ["resident permit"] }], time_spans: [] },
  "pol-sweep-tue": { curb_policy_id: "pol-sweep-tue", priority: 1,
    rules: [{ activity: "no parking", purposes: ["street cleaning"] }],
    time_spans: [{ days_of_week: ["tue"], time_of_day_start: "08:00", time_of_day_end: "12:00", start_date: "2026-04-01", end_date: "2026-11-30" }] },
  "pol-sweep-fri": { curb_policy_id: "pol-sweep-fri", priority: 1,
    rules: [{ activity: "no parking", purposes: ["street cleaning"] }],
    time_spans: [{ days_of_week: ["fri"], time_of_day_start: "12:00", time_of_day_end: "16:00", start_date: "2026-04-01", end_date: "2026-11-30" }] },
  "pol-loading": { curb_policy_id: "pol-loading", priority: 5,
    rules: [{ activity: "loading", user_classes: ["commercial"] }],
    time_spans: [{ days_of_week: ["mon","tue","wed","thu","fri"], time_of_day_start: "07:00", time_of_day_end: "11:00" }] },
  "pol-nostop": { curb_policy_id: "pol-nostop", priority: 0, rules: [{ activity: "no stopping" }], time_spans: [] },
  "pol-rush": { curb_policy_id: "pol-rush", priority: 0, rules: [{ activity: "travel" }],
    time_spans: [{ days_of_week: ["mon","tue","wed","thu","fri"], time_of_day_start: "16:00", time_of_day_end: "18:00" }] },
  "pol-hp": { curb_policy_id: "pol-hp", priority: 2, rules: [{ activity: "parking", user_classes: ["disabled placard"] }], time_spans: [] },
  "pol-free-2h": { curb_policy_id: "pol-free-2h", priority: 30, rules: [{ activity: "parking", max_stay: 120, user_classes: ["car"] }], time_spans: [] },
};
const MIXES = [
  ["pol-sweep-tue", "pol-meter-2h", "pol-rpp"], ["pol-loading", "pol-meter-2h"], ["pol-nostop"], ["pol-meter-2h"],
  ["pol-rpp", "pol-sweep-fri"], ["pol-rush", "pol-meter-30m", "pol-rpp"], ["pol-hp"], ["pol-free-2h", "pol-sweep-tue"], ["pol-meter-30m"],
];
const STREETS = ["Newbury St", "Boylston St", "Commonwealth Ave", "Beacon St", "Tremont St", "Washington St", "Hanover St", "Mass Ave"];

// Deterministic grid of short E-W curb segments, ~0.0025° apart, across the Boston bbox.
export const BBOX = [-71.19, 42.23, -70.99, 42.40];
export const ZONES = [];
let n = 0;
for (let lat = BBOX[1]; lat < BBOX[3]; lat += 0.0025) {
  for (let lng = BBOX[0]; lng < BBOX[2]; lng += 0.0025) {
    const i = n++;
    const mix = MIXES[i % MIXES.length];
    const poly = i % 11 === 0;
    const geometry = poly
      ? { type: "Polygon", coordinates: [[[lng, lat], [lng + 0.0015, lat], [lng + 0.0015, lat + 0.00008], [lng, lat + 0.00008], [lng, lat]]] }
      : { type: "LineString", coordinates: [[lng, lat], [lng + 0.0015, lat + 0.0001]] };
    ZONES.push({
      curb_zone_id: `bos-${i}`, user_zone_id: String(2000 + (i % 900)), published_date: "2026-01-01", last_updated_date: "2026-10-30",
      street_name: STREETS[i % STREETS.length], street_side: i % 2 ? "N" : "S", curb_policy_ids: mix, geometry,
    });
  }
}

const envelope = (key, items) => ({ version: "1.0", time_zone: "America/New_York", last_updated: Date.UTC(2026, 9, 30), data: { [key]: items } });
const inBbox = (z, [a, b, c, d]) => {
  const pts = z.geometry.type === "Polygon" ? z.geometry.coordinates[0] : z.geometry.coordinates;
  return pts.some(([x, y]) => x >= a && x <= c && y >= b && y <= d);
};

const firstPoint = (g) => (g.type === "Polygon" ? g.coordinates[0][0] : g.coordinates[0]);
export const METERS = ZONES.filter((z) => z.curb_policy_ids.includes("pol-meter-2h")).slice(0, 2000).map((z, i) => {
  const [lng, lat] = firstPoint(z.geometry);
  return { _id: i + 1, METER_ID: `M${1000 + i}`, STREET: z.street_name, LONGITUDE: String(lng), LATITUDE: String(lat) };
});

export const stats = { requests: 0, byPath: {} };

export function createMock() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    stats.requests++; stats.byPath[url.pathname] = (stats.byPath[url.pathname] || 0) + 1;
    const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

    if (url.pathname.startsWith("/curbs/")) {
      if (STRICT_ACCEPT && !/vnd\.cds\+json/.test(req.headers.accept || "")) return json(406, { error: "Accept: application/vnd.cds+json;version=1.0 required" });
      if (url.pathname === "/curbs/zones") {
        const q = url.searchParams;
        const bbox = ["min_lng", "min_lat", "max_lng", "max_lat"].map((k) => Number(q.get(k)));
        if (bbox.some(Number.isNaN)) return json(400, { error: "min_lng,min_lat,max_lng,max_lat required" });
        const limit = Number(q.get("limit") || 500), offset = Number(q.get("offset") || 0);
        const hits = ZONES.filter((z) => inBbox(z, bbox));
        const page = hits.slice(offset, offset + limit).map((z) => q.get("include_geometry") === "true" ? z : { ...z, geometry: undefined });
        return json(200, envelope("zones", page));
      }
      if (url.pathname === "/curbs/policies") {
        const ids = url.searchParams.get("ids");
        const list = ids ? ids.split(",").map((i) => POLICIES[i]).filter(Boolean) : Object.values(POLICIES);
        return json(200, envelope("policies", list));
      }
      return json(404, { error: "no such endpoint" });
    }
    if (url.pathname === "/openapi.json") return json(200, { openapi: "3.0.0", info: { title: "Mock CDS", version: "1.0" }, paths: { "/curbs/zones": {}, "/curbs/policies": {} } });

    // CKAN sliver
    if (url.pathname.endsWith("/package_search")) return json(200, { success: true, result: { results: [
      { title: "Parking Tickets", resources: [] },
      { title: "Parking Meters", name: "parking-meters", resources: [{ id: "ds-meters", name: "Parking Meters", datastore_active: true }] },
    ] } });
    if (url.pathname.endsWith("/datastore_search")) {
      const limit = Number(url.searchParams.get("limit") || 100), offset = Number(url.searchParams.get("offset") || 0);
      return json(200, { success: true, result: { records: METERS.slice(offset, offset + limit), total: METERS.length } });
    }
    json(404, { error: "mock: unknown path " + url.pathname });
  });
}

if (process.argv[1] && process.argv[1].endsWith("mock-cds.js")) {
  createMock().listen(PORT, () => console.log(`mock CDS on http://localhost:${PORT}  (${ZONES.length} zones, ${Object.keys(POLICIES).length} policies, strict=${STRICT_ACCEPT})`));
}
