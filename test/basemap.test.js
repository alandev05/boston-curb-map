import { describe, it, expect } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { buildStyle, PALETTES, OFM_TILES, LABEL_LAYERS, METER_LAYERS, ROADS, roadWidthPx, curbOffsetPx, CURB_FADE_ZOOM } from "../src/basemap.js";

const color = ["match", ["get", "cat"], "paid", "#3ea8ff", "#888"];

describe.each(["dark", "light"])("buildStyle(%s)", (theme) => {
  const style = buildStyle(theme, { colorExpr: color });
  const ids = style.layers.map((l) => l.id);
  const layer = (id) => style.layers.find((l) => l.id === id);

  it("is a valid v8 style with vector + two GeoJSON sources and glyphs", () => {
    expect(style.version).toBe(8);
    expect(style.sources.omt).toMatchObject({ type: "vector", url: OFM_TILES });
    expect(style.sources.zones).toMatchObject({ type: "geojson", promoteId: "curb_zone_id" });
    expect(style.sources.meters.type).toBe("geojson");
    expect(style.glyphs).toMatch(/\{fontstack\}.*\{range\}/);
  });
  it("uses the theme palette for background and labels", () => {
    expect(layer("bg").paint["background-color"]).toBe(PALETTES[theme].bg);
    for (const id of LABEL_LAYERS) expect(layer(id).paint["text-color"]).toBe(PALETTES[theme].label);
  });
  it("has flat 2D building footprints (no extrusion anywhere)", () => {
    const b = layer("buildings");
    expect(b.type).toBe("fill");
    expect(b.minzoom).toBe(14);
    expect(style.layers.some((l) => l.type === "fill-extrusion")).toBe(false);
  });
  it("orders buildings < curb lines < labels, so curbs draw over footprints and labels stay readable", () => {
    expect(ids.indexOf("buildings")).toBeLessThan(ids.indexOf("road"));
    expect(ids.indexOf("road")).toBeLessThan(ids.indexOf("zone-line"));
    for (const id of LABEL_LAYERS) expect(ids.indexOf("zone-line")).toBeLessThan(ids.indexOf(id));
    for (const id of [...LABEL_LAYERS, ...METER_LAYERS, "zone-fill", "zone-line"]) expect(ids).toContain(id);
  });
  it("curb lines are flat: colored by the category expression, no glow/blur layers", () => {
    expect(layer("zone-line").paint["line-color"]).toEqual(color);
    expect(layer("zone-line").minzoom).toBe(CURB_FADE_ZOOM); // zoomed out, the grid stands in for curbs
    expect(layer("zone-line").paint["line-blur"]).toBeUndefined();
    expect(ids.some((id) => /glow|core/.test(id))).toBe(false);
  });
  it("curbs are offset per side by data (snapped side × road class)", () => {
    expect(JSON.stringify(layer("zone-line").paint["line-offset"])).toMatch(/"side".*"rc"/);
  });
  it("discloses detail progressively: street names by class, house numbers last", () => {
    const mz = (id) => layer(id).minzoom ?? 0;
    expect(mz("road-label-major")).toBeLessThan(mz("road-label-mid"));
    expect(mz("road-label-mid")).toBeLessThan(mz("road-label-minor"));
    expect(mz("road-label-minor")).toBeLessThan(mz("road-label-service"));
    expect(mz("housenumber")).toBeGreaterThanOrEqual(18);
    expect(layer("place-neighbourhood").maxzoom).toBeLessThanOrEqual(17);
    expect(layer("place-city").maxzoom).toBeLessThanOrEqual(14);
  });
  it("every symbol layer uses a font that exists on OpenFreeMap", () => {
    for (const l of style.layers.filter((l) => l.type === "symbol")) expect(l.layout["text-font"][0]).toMatch(/^Noto Sans (Regular|Bold|Italic)$/);
  });
  it("passes the MapLibre style-spec validator in both data modes", () => {
    const dim = ["==", ["slice", ["get", "sched"], 0, 1], "u"];
    expect(validateStyleMin(buildStyle(theme, { colorExpr: color, dimExpr: dim })).map((e) => e.message)).toEqual([]);
    const tiles = { url: "http://x/{z}/{x}/{y}.pbf", minzoom: 9, maxzoom: 15, bounds: [-72, 42, -71, 43], meters: true };
    expect(validateStyleMin(buildStyle(theme, { colorExpr: color, dimExpr: dim, tiles, filter: ["!", ["in", "x", ["literal", ["s"]]]] })).map((e) => e.message)).toEqual([]);
  });
  it("layer ids are unique and meters start hidden", () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of METER_LAYERS) expect(layer(id).layout.visibility).toBe("none");
  });
});

describe("themes differ where they should", () => {
  const d = buildStyle("dark", { colorExpr: color }), l = buildStyle("light", { colorExpr: color });
  it("light is light and dark is dark", () => {
    const lum = (hex) => parseInt(hex.slice(1, 3), 16);
    expect(lum(PALETTES.light.bg)).toBeGreaterThan(200);
    expect(lum(PALETTES.dark.bg)).toBeLessThan(40);
  });
  it("same layer ids in the same order (so setStyle diff can swap paint in place)", () => {
    expect(l.layers.map((x) => x.id)).toEqual(d.layers.map((x) => x.id));
  });
  it("same palette keys in both themes", () => {
    expect(Object.keys(PALETTES.light).sort()).toEqual(Object.keys(PALETTES.dark).sort());
  });
  it("unknown theme falls back to dark", () => {
    expect(buildStyle("neon").layers[0].paint["background-color"]).toBe(PALETTES.dark.bg);
  });
});

describe("road + curb geometry", () => {
  const mpp = (z) => (78271.517 * Math.cos((42.35 * Math.PI) / 180)) / 2 ** z;
  it("roads are drawn at true metric width at street zooms", () => {
    for (const z of [16, 18, 20]) expect(roadWidthPx("minor", z) * mpp(z)).toBeCloseTo(ROADS.minor.m, 5);
  });
  it("roads keep a legible pixel floor when zoomed out", () => {
    expect(roadWidthPx("motorway", 8)).toBeGreaterThan(1);
    expect(roadWidthPx("minor", 12)).toBeGreaterThan(ROADS.minor.m / mpp(12));
  });
  it("curbs sit inside the road edge and never cross the centerline", () => {
    for (const cls of Object.keys(ROADS)) for (let z = 9; z <= 22; z++) {
      const off = curbOffsetPx(cls, z);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThan(roadWidthPx(cls, z) / 2);
    }
  });
  it("unknown road class falls back to a minor street", () => {
    expect(roadWidthPx("nope", 17)).toBe(roadWidthPx("minor", 17));
  });
});
