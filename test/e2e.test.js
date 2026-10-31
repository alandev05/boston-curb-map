// End-to-end over real HTTP: mock city API ⇄ api/*.js (via scripts/dev-server.js) ⇄ built front-end.
// Requires `npm run build` for the static-asset checks (they're skipped if dist/ is missing).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasDist = existsSync(path.join(root, "dist", "index.html"));

function spawnServer(script, port, env = {}, extra = []) {
  const child = spawn(process.execPath, [path.join(root, "scripts", script), "--port", String(port), ...extra], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${script} did not start`)), 10000);
    child.stdout.on("data", (d) => { if (/localhost/.test(String(d))) { clearTimeout(t); resolve(); } });
    child.stderr.on("data", (d) => process.stderr.write(`[${script}] ${d}`));
  });
  return { child, ready };
}

const MOCK = 43210 + Math.floor(Math.random() * 100), API = MOCK + 200, MOCK_STRICT = MOCK + 400;
const base = `http://localhost:${API}`;
const procs = [];

beforeAll(async () => {
  const m = spawnServer("mock-cds.js", MOCK); procs.push(m.child); await m.ready;
  const s = spawnServer("dev-server.js", API, { CDS_BASE: `http://localhost:${MOCK}`, CKAN_BASE: `http://localhost:${MOCK}` }); procs.push(s.child); await s.ready;
}, 20000);
afterAll(() => procs.forEach((p) => p.kill()));

const NEWBURY = "-71.09,42.348,-71.075,42.353";

describe("mock city API sanity", () => {
  it("serves CDS envelopes", async () => {
    const js = await (await fetch(`http://localhost:${MOCK}/curbs/zones?min_lng=-71.09&min_lat=42.348&max_lng=-71.075&max_lat=42.353&include_geometry=true`)).json();
    expect(js.version).toBe("1.0");
    expect(js.data.zones.length).toBeGreaterThan(0);
    expect(js.data.zones[0].geometry).toBeDefined();
  });
});

describe("/api/zones over HTTP", () => {
  it("returns GeoJSON for a Newbury St bbox with geometry and policy ids", async () => {
    const r = await fetch(`${base}/api/zones?bbox=${NEWBURY}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/json/);
    expect(r.headers.get("cache-control")).toMatch(/s-maxage/);
    const fc = await r.json();
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.length).toBeGreaterThan(10);
    for (const f of fc.features) {
      expect(f.type).toBe("Feature");
      expect(["LineString", "Polygon"]).toContain(f.geometry.type);
      expect(f.properties.curb_zone_id).toMatch(/^bos-/);
      expect(Array.isArray(f.properties.curb_policy_ids)).toBe(true);
    }
    expect(fc.meta.last_updated).toBeTypeOf("number");
  });

  it("only returns zones inside the bbox", async () => {
    const fc = await (await fetch(`${base}/api/zones?bbox=${NEWBURY}`)).json();
    const [a, b, c, d] = NEWBURY.split(",").map(Number);
    for (const f of fc.features) {
      const pts = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates;
      expect(pts.some(([x, y]) => x >= a && x <= c && y >= b && y <= d)).toBe(true);
    }
  });

  it("paginates a big bbox past 500 zones", async () => {
    const fc = await (await fetch(`${base}/api/zones?bbox=-71.15,42.25,-71.00,42.39`)).json();
    expect(fc.features.length).toBeGreaterThan(500);
    const ids = new Set(fc.features.map((f) => f.properties.curb_zone_id));
    expect(ids.size).toBe(fc.features.length); // no dupes across pages
  });

  it("citywide lite overview returns every zone, small", async () => {
    const r = await fetch(`${base}/api/zones?bbox=-71.1912,42.2279,-70.9860,42.3969&lite=1`);
    const text = await r.text(); const fc = JSON.parse(text);
    expect(fc.features.length).toBeGreaterThan(4000);
    expect(text.length / fc.features.length).toBeLessThan(300); // bytes per zone
    expect(fc.features[0].properties.published_date).toBeUndefined();
  });

  it("400s on bad bbox, 404s on unknown route", async () => {
    expect((await fetch(`${base}/api/zones?bbox=nope`)).status).toBe(400);
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
  });
});

describe("/api/policies over HTTP", () => {
  it("returns all policies keyed by id", async () => {
    const js = await (await fetch(`${base}/api/policies`)).json();
    expect(Object.keys(js).length).toBeGreaterThanOrEqual(10);
    expect(js["pol-meter-2h"].rules[0].rate[0].rate).toBe(375);
  });
  it("filters by ids", async () => {
    const js = await (await fetch(`${base}/api/policies?ids=pol-rpp,pol-nostop,ghost`)).json();
    expect(Object.keys(js).sort()).toEqual(["pol-nostop", "pol-rpp"]);
  });
  it("every policy id referenced by zones resolves", async () => {
    const fc = await (await fetch(`${base}/api/zones?bbox=${NEWBURY}`)).json();
    const pols = await (await fetch(`${base}/api/policies`)).json();
    for (const f of fc.features) for (const id of f.properties.curb_policy_ids) expect(pols[id], id).toBeDefined();
  });
});

describe("/api/meters over HTTP", () => {
  it("returns point features from the CKAN mock", async () => {
    const fc = await (await fetch(`${base}/api/meters`)).json();
    const { METERS } = await import("../scripts/mock-cds.js");
    expect(METERS.length).toBeGreaterThan(1000);
    expect(fc.features.length).toBe(METERS.length); // nothing dropped by the coordinate sanity box
    expect(new Set(fc.features.map((f) => f.properties.METER_ID)).size).toBe(METERS.length);
    expect(fc.features[0].geometry.type).toBe("Point");
    const [lng, lat] = fc.features[0].geometry.coordinates;
    expect(lng).toBeLessThan(-70); expect(lat).toBeGreaterThan(42);
    expect(fc.meta.resource).toBe("ds-meters");
  });
});

describe("rule engine against API data (the thing the map does)", () => {
  it("colors every zone, and the demo-style mixes resolve as expected across the week", async () => {
    const { verdict } = await import("../src/rules.js");
    const fc = await (await fetch(`${base}/api/zones?bbox=-71.15,42.25,-71.00,42.39`)).json();
    const pols = await (await fetch(`${base}/api/policies`)).json();
    const counts = {};
    for (const f of fc.features) {
      const c = verdict(f.properties, pols, "tue", 9 * 60).category;
      counts[c] = (counts[c] || 0) + 1;
    }
    // Tue 9am: sweeping, loading, meters, no-stopping, resident, accessible all present; nothing unknown.
    expect(counts.unknown ?? 0).toBe(0);
    for (const k of ["no_parking", "loading", "paid", "no_stopping", "resident", "accessible"]) expect(counts[k], k).toBeGreaterThan(0);
    // Rush hour zone becomes a travel lane at 5pm weekdays only.
    const rush = fc.features.find((f) => f.properties.curb_policy_ids.includes("pol-rush"));
    expect(verdict(rush.properties, pols, "wed", 17 * 60).category).toBe("travel");
    expect(verdict(rush.properties, pols, "wed", 13 * 60).category).toBe("paid");
    expect(verdict(rush.properties, pols, "sat", 17 * 60).category).toBe("paid");
    expect(verdict(rush.properties, pols, "sun", 17 * 60).category).toBe("resident");
  });
});

describe("Accept-header fallback (strict mock)", () => {
  let strict, api2;
  beforeAll(async () => {
    strict = spawnServer("mock-cds.js", MOCK_STRICT, {}, ["--strict", "true"]); procs.push(strict.child); await strict.ready;
    api2 = spawnServer("dev-server.js", MOCK_STRICT + 1, { CDS_BASE: `http://localhost:${MOCK_STRICT}` }); procs.push(api2.child); await api2.ready;
  }, 20000);
  it("plain JSON Accept is rejected by the mock, yet /api/zones still works (CDS header sent first)", async () => {
    expect((await fetch(`http://localhost:${MOCK_STRICT}/curbs/policies`, { headers: { Accept: "application/json" } })).status).toBe(406);
    const fc = await (await fetch(`http://localhost:${MOCK_STRICT + 1}/api/zones?bbox=${NEWBURY}`)).json();
    expect(fc.features.length).toBeGreaterThan(0);
  });
});

const hasTiles = existsSync(path.join(root, "public", "data", "manifest.json"));
describe.skipIf(!hasDist || !hasTiles)("static tiles mode over HTTP", () => {
  it("serves the manifest and policies bundle", async () => {
    const m = await (await fetch(`${base}/data/manifest.json`)).json();
    expect(m.tiles).toBeGreaterThan(100);
    expect(m.tile_url).toBe("/tiles/{z}/{x}/{y}.pbf");
    const pol = await (await fetch(`${base}/data/policies.json`)).json();
    expect(Object.keys(pol).length).toBeGreaterThan(5);
  });
  it("serves tiles gzip-encoded with a protobuf content type, decodable as MVT", async () => {
    const m = await (await fetch(`${base}/data/manifest.json`)).json();
    // centre tile of the bbox at detail zoom
    const z = m.detail_zoom, lon = (m.bbox[0] + m.bbox[2]) / 2, lat = (m.bbox[1] + m.bbox[3]) / 2;
    const x = Math.floor(((lon + 180) / 360) * 2 ** z);
    const y = Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
    const r = await fetch(`${base}/tiles/${z}/${x}/${y}.pbf`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/protobuf/);
    expect(r.headers.get("content-encoding")).toBe("gzip"); // fetch() transparently decodes
    const { VectorTile } = await import("@mapbox/vector-tile"); const Pbf = (await import("pbf")).default;
    const tile = new VectorTile(new Pbf(new Uint8Array(await r.arrayBuffer())));
    expect(tile.layers.curbs.length).toBeGreaterThan(0);
    expect(tile.layers.curbs.feature(0).properties.sched).toHaveLength(168);
  });
  it("manifest reports meters baked into the tiles", async () => {
    const m = await (await fetch(`${base}/data/manifest.json`)).json();
    expect(m.meters).toBeGreaterThan(1000);
  });
  it("the bundle boots into tiles mode (reads the manifest, slices sched)", async () => {
    const html = await (await fetch(`${base}/`)).text();
    const js = html.match(/src="(\/assets\/[^"]+\.js)"/)[1];
    const bundle = await (await fetch(base + js)).text();
    expect(bundle).toMatch(/\/data\/manifest\.json/);
    expect(bundle).toMatch(/"slice"/);
  });
});

describe.skipIf(!hasDist)("built front-end is served", () => {
  it("index.html and the JS/CSS bundle load", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toMatch(/Curb parking rules/);
    const js = html.match(/src="(\/assets\/[^"]+\.js)"/)[1];
    const css = html.match(/href="(\/assets\/[^"]+\.css)"/)[1];
    const jr = await fetch(base + js); expect(jr.status).toBe(200); expect(jr.headers.get("content-type")).toMatch(/javascript/);
    const bundle = await jr.text();
    expect(bundle).toMatch(/\/api\/zones\?bbox=/); // front-end actually calls our API
    expect(bundle).toMatch(/tiles\.openfreemap\.org/);
    expect(bundle).not.toMatch(/buildings-3d/); // 2D only (our style has no extrusion layer)
    expect(bundle).toMatch(/lite=1/); // citywide overview wired up
    expect(html).not.toMatch(/fonts\.googleapis/); // system font only
    expect(html).toMatch(/dataset\.theme/); // theme bootstrapped before paint
    expect((await fetch(base + css)).status).toBe(200);
  });
  it("unknown paths fall back to index.html (SPA)", async () => {
    expect(await (await fetch(`${base}/some/deep/link`)).text()).toMatch(/Curb parking rules/);
  });
});
