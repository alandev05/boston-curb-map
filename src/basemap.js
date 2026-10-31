// Dark "look under the city" basemap: OpenMapTiles-schema vector tiles from OpenFreeMap
// (free, no key) with 3D extruded buildings, dim streets, and light labels.
// Curb lines are added on top by main.js so they thread between the towers.

export const OFM_TILES = "https://tiles.openfreemap.org/planet";
export const OFM_GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

export const PALETTE = {
  bg: "#0b0d14", water: "#060a14", park: "#0f1a16", road: "#1b2030", roadMajor: "#262c40", roadOutline: "#0b0d14",
  building: "#2b3040", buildingTop: "#474e63", label: "#c9d1e3", labelHalo: "#0b0d14",
};

const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];

export function darkStyle() {
  return {
    version: 8,
    glyphs: OFM_GLYPHS,
    sources: { omt: { type: "vector", url: OFM_TILES, attribution: "© OpenStreetMap contributors, © OpenFreeMap" } },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": PALETTE.bg } },
      { id: "park", type: "fill", source: "omt", "source-layer": "park", paint: { "fill-color": PALETTE.park } },
      { id: "landuse-green", type: "fill", source: "omt", "source-layer": "landuse", filter: ["in", "class", "grass", "cemetery", "wood", "pitch", "playground"], paint: { "fill-color": PALETTE.park, "fill-opacity": 0.7 } },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": PALETTE.water } },
      { id: "waterway", type: "line", source: "omt", "source-layer": "waterway", paint: { "line-color": PALETTE.water, "line-width": 1.5 } },

      // Streets: a dark slab with a slightly lighter core so the grid reads at a tilt.
      { id: "road-outline", type: "line", source: "omt", "source-layer": "transportation", minzoom: 12,
        filter: ["!in", "class", "path", "rail", "transit", "ferry"], layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": PALETTE.roadOutline, "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 12, 1.5, 16, 10, 19, 36] } },
      { id: "road-minor", type: "line", source: "omt", "source-layer": "transportation", minzoom: 12,
        filter: ["all", ["!in", "class", "path", "rail", "transit", "ferry", "motorway", "trunk", "primary", "secondary"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": PALETTE.road, "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 12, 0.6, 16, 6, 19, 26] } },
      { id: "road-major", type: "line", source: "omt", "source-layer": "transportation",
        filter: ["in", "class", "motorway", "trunk", "primary", "secondary"], layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": PALETTE.roadMajor, "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, 0.8, 16, 8, 19, 30] } },
      { id: "rail", type: "line", source: "omt", "source-layer": "transportation", filter: ["==", "class", "rail"],
        paint: { "line-color": "#1a1f2c", "line-width": 1, "line-dasharray": [3, 3] } },

      // The city: extruded buildings, lighter at the top so towers catch "light".
      { id: "buildings-3d", type: "fill-extrusion", source: "omt", "source-layer": "building", minzoom: 13,
        paint: {
          "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 10], 0, PALETTE.building, 60, "#3a4154", 150, PALETTE.buildingTop],
          "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, ["coalesce", ["get", "render_height"], 10]],
          "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, ["coalesce", ["get", "render_min_height"], 0]],
          "fill-extrusion-opacity": 0.92, "fill-extrusion-vertical-gradient": true,
        } },

      // Labels
      { id: "road-label", type: "symbol", source: "omt", "source-layer": "transportation_name", minzoom: 14,
        layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 14], "text-letter-spacing": 0.05, "symbol-spacing": 350 },
        paint: { "text-color": PALETTE.label, "text-halo-color": PALETTE.labelHalo, "text-halo-width": 1.6, "text-opacity": 0.9 } },
      { id: "place-neighbourhood", type: "symbol", source: "omt", "source-layer": "place", filter: ["in", "class", "neighbourhood", "suburb", "quarter"],
        layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": FONT, "text-size": 11, "text-transform": "uppercase", "text-letter-spacing": 0.25 },
        paint: { "text-color": "#8a93a8", "text-halo-color": PALETTE.labelHalo, "text-halo-width": 1.2 } },
      { id: "place-city", type: "symbol", source: "omt", "source-layer": "place", filter: ["in", "class", "city", "town"], maxzoom: 14,
        layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": FONT_BOLD, "text-size": 14, "text-letter-spacing": 0.2 },
        paint: { "text-color": PALETTE.label, "text-halo-color": PALETTE.labelHalo, "text-halo-width": 1.5 } },
    ],
  };
}

// Glow treatment for curb lines, layered: wide soft halo → crisp colored line → thin bright core.
export function glowLayers(colorExpr, hoverExpr) {
  const w = (z12, z16, z19) => ["interpolate", ["exponential", 1.3], ["zoom"], 12, z12, 16, z16, 19, z19];
  return [
    { id: "zone-fill", type: "fill", source: "zones", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": colorExpr, "fill-opacity": 0.25 } },
    { id: "zone-glow", type: "line", source: "zones", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": colorExpr, "line-width": w(6, 16, 34), "line-blur": w(5, 12, 24), "line-opacity": ["case", hoverExpr, 0.95, 0.55] } },
    { id: "zone-line", type: "line", source: "zones", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": colorExpr, "line-width": w(1.8, 5, 11), "line-opacity": 1 } },
    { id: "zone-core", type: "line", source: "zones", layout: { "line-cap": "round", "line-join": "round" }, minzoom: 15,
      paint: { "line-color": "#ffffff", "line-width": w(0.4, 1.4, 3.5), "line-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 17, 0.75] } },
  ];
}
