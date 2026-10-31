import { describe, it, expect } from "vitest";
import { buildStyle, PALETTES, OFM_TILES, LABEL_LAYERS, METER_LAYERS } from "../src/basemap.js";

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
    expect(layer("road-label").paint["text-color"]).toBe(PALETTES[theme].label);
  });
  it("has height-driven 3D buildings that are flat at city scale", () => {
    const b = layer("buildings-3d");
    expect(b.type).toBe("fill-extrusion");
    expect(JSON.stringify(b.paint["fill-extrusion-height"])).toMatch(/render_height/);
    expect(b.paint["fill-extrusion-height"][4]).toBe(0); // zoom 13 → 0 height
  });
  it("orders buildings < curb lines < labels, so curbs thread between towers and labels stay readable", () => {
    expect(ids.indexOf("buildings-3d")).toBeLessThan(ids.indexOf("zone-glow"));
    expect(ids.indexOf("zone-core")).toBeLessThan(ids.indexOf("road-label"));
    for (const id of [...LABEL_LAYERS, ...METER_LAYERS, "zone-fill", "zone-glow", "zone-line", "zone-core"]) expect(ids).toContain(id);
  });
  it("curb lines are colored by the category expression and stay visible at city scale", () => {
    expect(layer("zone-line").paint["line-color"]).toEqual(color);
    expect(layer("zone-line").minzoom).toBeUndefined();
    expect(layer("zone-glow").paint["line-width"][4]).toBeLessThan(layer("zone-glow").paint["line-width"][10]); // thin far, thick near
  });
  it("every symbol layer uses a font that exists on OpenFreeMap", () => {
    for (const l of style.layers.filter((l) => l.type === "symbol")) expect(l.layout["text-font"][0]).toMatch(/^Noto Sans (Regular|Bold)$/);
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
  it("glow is softer in light mode", () => {
    expect(PALETTES.light.glowOpacity).toBeLessThan(PALETTES.dark.glowOpacity);
  });
  it("unknown theme falls back to dark", () => {
    expect(buildStyle("neon").layers[0].paint["background-color"]).toBe(PALETTES.dark.bg);
  });
});
