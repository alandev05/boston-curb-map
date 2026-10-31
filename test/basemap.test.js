import { describe, it, expect } from "vitest";
import { darkStyle, glowLayers, OFM_TILES } from "../src/basemap.js";

describe("darkStyle", () => {
  const style = darkStyle();
  const ids = style.layers.map((l) => l.id);
  it("is a valid v8 style with a vector source and glyphs", () => {
    expect(style.version).toBe(8);
    expect(style.sources.omt).toMatchObject({ type: "vector", url: OFM_TILES });
    expect(style.glyphs).toMatch(/\{fontstack\}.*\{range\}/);
  });
  it("has 3D buildings with height-driven extrusion and a dark background", () => {
    const b = style.layers.find((l) => l.id === "buildings-3d");
    expect(b.type).toBe("fill-extrusion");
    expect(JSON.stringify(b.paint["fill-extrusion-height"])).toMatch(/render_height/);
    expect(style.layers[0]).toMatchObject({ type: "background" });
    expect(style.layers[0].paint["background-color"]).toMatch(/^#0/);
  });
  it("draws buildings before labels (so curb lines inserted before road-label sit on top of towers)", () => {
    expect(ids.indexOf("buildings-3d")).toBeLessThan(ids.indexOf("road-label"));
  });
  it("every symbol layer uses a font that exists on OpenFreeMap", () => {
    for (const l of style.layers.filter((l) => l.type === "symbol")) expect(l.layout["text-font"][0]).toMatch(/^Noto Sans (Regular|Bold)$/);
  });
  it("layer ids are unique", () => expect(new Set(ids).size).toBe(ids.length));
});

describe("glowLayers", () => {
  const color = ["match", ["get", "cat"], "paid", "#3ea8ff", "#5c6370"];
  const layers = glowLayers(color, ["boolean", ["feature-state", "hover"], false]);
  it("stacks halo → line → core on the zones source", () => {
    expect(layers.map((l) => l.id)).toEqual(["zone-fill", "zone-glow", "zone-line", "zone-core"]);
    for (const l of layers) expect(l.source).toBe("zones");
  });
  it("glow is wider and blurrier than the crisp line at every zoom", () => {
    const glow = layers.find((l) => l.id === "zone-glow"), line = layers.find((l) => l.id === "zone-line");
    const stops = (expr) => expr.slice(3).filter((_, i) => i % 2 === 1);
    const gw = stops(glow.paint["line-width"]), lw = stops(line.paint["line-width"]);
    gw.forEach((w, i) => expect(w).toBeGreaterThan(lw[i]));
    expect(glow.paint["line-blur"]).toBeDefined();
  });
  it("the white core only fades in when zoomed in", () => {
    const core = layers.find((l) => l.id === "zone-core");
    expect(core.minzoom).toBeGreaterThanOrEqual(15);
    expect(core.paint["line-opacity"][4]).toBe(0);
  });
});
