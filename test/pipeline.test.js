import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { encodeSchedule, dominant, slotIndex, codeAt, CODES, CATEGORY_OF, DAYS, SLOTS } from "../src/schedule.js";
import { verdict, isRealPolicy } from "../src/rules.js";
import { prepare, buildTiles, MIN_ZOOM, MAX_ZOOM, NO_DATA_ZOOM, METERS_ZOOM, CURB_SHARD } from "../scripts/build-tiles.js";
import { POLICIES, ZONES, METERS } from "../scripts/mock-cds.js";

const toFeature = (z) => { const { geometry, ...properties } = z; return { type: "Feature", geometry, properties }; };

describe("schedule encoding", () => {
  it("is 336 chars, mon..sun × 48 half hours, and agrees with verdict() at every slot", () => {
    const z = ZONES.find((x) => x.curb_policy_ids.includes("pol-rush"));
    const s = encodeSchedule(z, POLICIES);
    expect(s).toHaveLength(SLOTS);
    for (const day of DAYS) for (let h = 0; h < 24; h++) {
      expect(CATEGORY_OF[s[slotIndex(day, h * 60)]]).toBe(verdict(z, POLICIES, day, h * 60 + 15).category);
    }
  });
  it("rush-hour zone reads travel Wed 5pm, paid Wed 1pm, resident Sun 5pm", () => {
    const z = ZONES.find((x) => x.curb_policy_ids.includes("pol-rush"));
    const s = encodeSchedule(z, POLICIES);
    expect(s[slotIndex("wed", 17 * 60)]).toBe(CODES.travel);
    expect(s[slotIndex("wed", 13 * 60)]).toBe(CODES.paid);
    expect(s[slotIndex("sun", 17 * 60)]).toBe(CODES.resident);
  });
  it("every category has a unique single-letter code", () => {
    const codes = Object.values(CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toHaveLength(1);
  });
  it("dominant picks the most common code", () => {
    expect(dominant("pppnn")).toBe("p");
    expect(dominant("")).toBe("u");
  });
  it("codeAt is a valid expression that falls back to dom when sched is absent", () => {
    const e = codeAt(5);
    expect(e[0]).toBe("case");
    expect(JSON.stringify(e)).toContain('"slice"');
    expect(JSON.stringify(e)).toContain('"dom"');
  });
});

describe("prepare()", () => {
  it("flattens zone props into short tile keys + a rule-set index + dom", () => {
    const rulesets = [];
    const f = prepare([toFeature(ZONES[0])], POLICIES, rulesets)[0];
    expect(Object.keys(f.properties).sort()).toEqual(["dom", "len", "rc", "rs", "side"]);
    expect(f.id).toBe(0); // a small integer feature id, not the city's 36-character one
    expect(rulesets[f.properties.rs]).toBe(ZONES[0].curb_policy_ids.join(","));
    expect(f.properties.dom).toHaveLength(1);
  });
  it("curbs with the same rules share one rule-set index", () => {
    const rulesets = [];
    const [a, b, c] = prepare([toFeature(ZONES[0]), toFeature(ZONES[0]), toFeature({ ...ZONES[0], curb_policy_ids: [] })], POLICIES, rulesets);
    expect(a.properties.rs).toBe(b.properties.rs);
    expect(c.properties.rs).not.toBe(a.properties.rs);
    expect(rulesets).toHaveLength(2);
  });
  it("drops zones with no geometry", () => {
    expect(prepare([{ properties: { curb_zone_id: "x" }, geometry: null }], POLICIES)).toHaveLength(0);
  });
});

describe("buildTiles()", () => {
  let out, manifest;
  // Every other curb sits on a primary road (as if snapped), so the overview zooms have something to carry.
  // Curbs (as prepare() numbers them) with at least one readable rule — what the tiles below NO_DATA_ZOOM carry.
  const ruled = () => { const rs = []; return prepare(subset, POLICIES, rs).filter((f) => rs[f.properties.rs].split(",").some((id) => isRealPolicy(POLICIES[id]))); };
  const subset = ZONES.slice(0, 600).map(toFeature).map((f, i) => (i % 2 ? f : { ...f, properties: { ...f.properties, _rc: "primary", _side: 1 } }));
  beforeAll(async () => {
    out = await mkdtemp(path.join(os.tmpdir(), "curb-tiles-"));
    const meters = METERS.slice(0, 200).map((m) => ({ type: "Feature", geometry: { type: "Point", coordinates: [Number(m.LONGITUDE), Number(m.LATITUDE)] }, properties: { METER_ID: m.METER_ID, STREET: m.STREET } }));
    manifest = await buildTiles(subset, POLICIES, { out, log: () => {}, meta: { source: "test" }, meters });
  }, 60000);
  it("records meters in the manifest", () => { expect(manifest.meters).toBe(200); expect(manifest.meters_zoom).toBe(METERS_ZOOM); });
  it("meters live in a `meters` point layer from METERS_ZOOM up, and not below", async () => {
    const count = async (z) => {
      let n = 0;
      for (const x of await readdir(path.join(out, "tiles", String(z)))) for (const y of await readdir(path.join(out, "tiles", String(z), x))) {
        const t = new VectorTile(new Pbf(gunzipSync(await readFile(path.join(out, "tiles", String(z), x, y)))));
        if (t.layers.meters) { n += t.layers.meters.length; expect(t.layers.meters.feature(0).properties.METER_ID).toMatch(/^M/); }
      }
      return n;
    };
    for (let z = MIN_ZOOM; z < METERS_ZOOM; z++) expect(await count(z)).toBe(0);
    expect(await count(MAX_ZOOM)).toBeGreaterThanOrEqual(200);
  });

  it("writes a manifest with counts, bbox and zoom range", () => {
    expect(manifest).toMatchObject({ zones: 600, source: "test", minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM });
    // every data URL carries the build version, so a browser never mixes tiles and rules from different builds
    expect(manifest.version).toMatch(/^[0-9a-z]+$/);
    expect(manifest.tile_url).toBe(`/tiles/{z}/{x}/{y}.pbf?v=${manifest.version}`);
    expect(manifest.tiles).toBeGreaterThan(10);
    expect(manifest.bbox[0]).toBeLessThan(manifest.bbox[2]);
  });
  it("writes the feature id → city curb lookup in shards, with each curb's rule set", async () => {
    expect(manifest.curb_shard).toBe(CURB_SHARD);
    const shard0 = JSON.parse(await readFile(path.join(out, "data", "curbs", "0.json"), "utf8"));
    expect(shard0).toHaveLength(Math.min(CURB_SHARD, manifest.zones));
    for (const [zone, rs] of shard0) { expect(subset.some((f) => f.properties.curb_zone_id === zone)).toBe(true); expect(Number.isInteger(rs)).toBe(true); }
    const line = shard0.find((r) => r[2] != null); // lines carry their length (areas can't be split into stretches)
    expect(line[2]).toBeGreaterThan(0);
  });
  it("writes a zoom directory for every level in range", async () => {
    const zs = (await readdir(path.join(out, "tiles"))).map(Number).sort((a, b) => a - b);
    expect(zs[0]).toBe(MIN_ZOOM); expect(zs.at(-1)).toBe(MAX_ZOOM);
  });
  it("tiles are gzipped MVTs with a `curbs` layer", async () => {
    const z = String(MAX_ZOOM);
    const xs = await readdir(path.join(out, "tiles", z));
    const ys = await readdir(path.join(out, "tiles", z, xs[0]));
    const buf = await readFile(path.join(out, "tiles", z, xs[0], ys[0]));
    expect(buf[0]).toBe(0x1f); expect(buf[1]).toBe(0x8b); // gzip magic
    const tile = new VectorTile(new Pbf(gunzipSync(buf)));
    expect(tile.layers.curbs).toBeDefined();
    expect(tile.layers.curbs.extent).toBe(4096);
    const f = tile.layers.curbs.feature(0);
    expect(Number.isInteger(f.properties.rs)).toBe(true);
    expect(Number.isInteger(f.id)).toBe(true);
    expect(f.properties.dom).toHaveLength(1);
  });
  const idsAt = async (zoom) => {
    const ids = new Set(), z = String(zoom);
    for (const x of await readdir(path.join(out, "tiles", z))) for (const y of await readdir(path.join(out, "tiles", z, x))) {
      const layer = new VectorTile(new Pbf(gunzipSync(await readFile(path.join(out, "tiles", z, x, y))))).layers.curbs;
      const seen = new Set();
      for (let i = 0; i < layer?.length; i++) { const id = layer.feature(i).id; expect(seen.has(id)).toBe(false); seen.add(id); ids.add(id); }
    }
    return ids;
  };
  it("from NO_DATA_ZOOM the tiles contain every zone, exactly once per tile", async () => {
    expect((await idsAt(NO_DATA_ZOOM)).size).toBe(600);
    expect((await idsAt(MAX_ZOOM)).size).toBe(600);
  });
  it("from MIN_ZOOM to NO_DATA_ZOOM they carry every curb with a readable rule, and only those", async () => {
    const want = new Set(ruled().map((f) => f.id));
    expect(want.size).toBeGreaterThan(0);
    for (let z = MIN_ZOOM; z < NO_DATA_ZOOM; z++) expect([...(await idsAt(z))].sort()).toEqual([...want].sort());
  });
  it("writes the rule sets the tiles index into", async () => {
    const rs = JSON.parse(await readFile(path.join(out, "data", "rulesets.json"), "utf8"));
    expect(rs).toContain(ZONES[0].curb_policy_ids.join(","));
    expect(manifest.rulesets).toBe(rs.length);
  });
  it("writes a slim policies bundle", async () => {
    const pol = JSON.parse(await readFile(path.join(out, "data", "policies.json"), "utf8"));
    expect(Object.keys(pol).sort()).toEqual(Object.keys(POLICIES).sort());
    expect(pol["pol-meter-2h"].rules[0].rate[0].rate).toBe(375);
    expect(pol["pol-meter-2h"].time_spans).toHaveLength(1);
  });
});

