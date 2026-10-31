import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { encodeSchedule, dominant, slotIndex, codeAt, CODES, CATEGORY_OF, DAYS, SLOTS } from "../src/schedule.js";
import { verdict } from "../src/rules.js";
import { prepare, buildTiles, MIN_ZOOM, MAX_ZOOM, DETAIL_ZOOM, METERS_ZOOM } from "../scripts/build-tiles.js";
import { POLICIES, ZONES, METERS } from "../scripts/mock-cds.js";

const toFeature = (z) => { const { geometry, ...properties } = z; return { type: "Feature", geometry, properties }; };

describe("schedule encoding", () => {
  it("is 168 chars, mon..sun × 24, and agrees with verdict() at every slot", () => {
    const z = ZONES.find((x) => x.curb_policy_ids.includes("pol-rush"));
    const s = encodeSchedule(z, POLICIES);
    expect(s).toHaveLength(SLOTS);
    for (const day of DAYS) for (let h = 0; h < 24; h++) {
      expect(CATEGORY_OF[s[slotIndex(day, h)]]).toBe(verdict(z, POLICIES, day, h * 60).category);
    }
  });
  it("rush-hour zone reads travel Wed 5pm, paid Wed 1pm, resident Sun 5pm", () => {
    const z = ZONES.find((x) => x.curb_policy_ids.includes("pol-rush"));
    const s = encodeSchedule(z, POLICIES);
    expect(s[slotIndex("wed", 17)]).toBe(CODES.travel);
    expect(s[slotIndex("wed", 13)]).toBe(CODES.paid);
    expect(s[slotIndex("sun", 17)]).toBe(CODES.resident);
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
  it("flattens zone props into short tile keys + sched + dom", () => {
    const f = prepare([toFeature(ZONES[0])], POLICIES)[0];
    expect(Object.keys(f.properties).sort()).toEqual(["dom", "id", "pids", "sched", "side", "street", "zone"]);
    expect(f.properties.id).toBe(ZONES[0].curb_zone_id);
    expect(f.properties.pids).toBe(ZONES[0].curb_policy_ids.join(","));
    expect(f.properties.sched).toHaveLength(168);
  });
  it("drops zones with no geometry", () => {
    expect(prepare([{ properties: { curb_zone_id: "x" }, geometry: null }], POLICIES)).toHaveLength(0);
  });
});

describe("buildTiles()", () => {
  let out, manifest;
  const subset = ZONES.slice(0, 600).map(toFeature);
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
    expect(await count(METERS_ZOOM - 1)).toBe(0);
    expect(await count(MAX_ZOOM)).toBeGreaterThanOrEqual(200);
  });

  it("writes a manifest with counts, bbox and zoom range", () => {
    expect(manifest).toMatchObject({ zones: 600, source: "test", minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM, detail_zoom: DETAIL_ZOOM, tile_url: "/tiles/{z}/{x}/{y}.pbf" });
    expect(manifest.tiles).toBeGreaterThan(10);
    expect(manifest.bbox[0]).toBeLessThan(manifest.bbox[2]);
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
    expect(f.properties.sched).toHaveLength(168);
    expect(f.properties.id).toMatch(/^bos-/);
    expect(f.properties.dom).toHaveLength(1);
  });
  it("overview tiles carry only id + dom (no 168-char sched) so the city-scale tile stays small", async () => {
    const z = String(MIN_ZOOM);
    const ids = new Set(); let bytes = 0;
    for (const x of await readdir(path.join(out, "tiles", z))) for (const y of await readdir(path.join(out, "tiles", z, x))) {
      const buf = await readFile(path.join(out, "tiles", z, x, y)); bytes += buf.length;
      const layer = new VectorTile(new Pbf(gunzipSync(buf))).layers.curbs;
      expect(Object.keys(layer.feature(0).properties).sort()).toEqual(["dom", "id"]);
      for (let i = 0; i < layer.length; i++) ids.add(layer.feature(i).properties.id);
    }
    expect(ids.size).toBe(600); // every zone present at city scale — none culled by simplification
    expect(bytes).toBeLessThan(20000);
  });
  it("detail tiles collectively contain every zone exactly once per tile", async () => {
    const ids = new Set();
    const z = String(DETAIL_ZOOM);
    for (const x of await readdir(path.join(out, "tiles", z))) for (const y of await readdir(path.join(out, "tiles", z, x))) {
      const layer = new VectorTile(new Pbf(gunzipSync(await readFile(path.join(out, "tiles", z, x, y))))).layers.curbs;
      const seen = new Set();
      for (let i = 0; i < layer.length; i++) { const id = layer.feature(i).properties.id; expect(seen.has(id)).toBe(false); seen.add(id); ids.add(id); }
    }
    expect(ids.size).toBe(600);
  });
  it("writes a slim policies bundle", async () => {
    const pol = JSON.parse(await readFile(path.join(out, "data", "policies.json"), "utf8"));
    expect(Object.keys(pol).sort()).toEqual(Object.keys(POLICIES).sort());
    expect(pol["pol-meter-2h"].rules[0].rate[0].rate).toBe(375);
    expect(pol["pol-meter-2h"].time_spans).toHaveLength(1);
  });
});
