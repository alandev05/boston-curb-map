// Basemap + overlay style, built per theme so the whole map can switch with map.setStyle(diff).
// Vector tiles: OpenFreeMap (OpenMapTiles schema, free, no key). Flat 2D, like Google Maps.
// Curb lines are part of the style so they survive theme switches.

export const OFM_TILES = "https://tiles.openfreemap.org/planet";
export const OFM_GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

export const PALETTES = {
  dark: {
    bg: "#0d0f14", water: "#07090f", park: "#111a16", road: "#1a1e2a", roadMajor: "#242938", roadOutline: "#0d0f14",
    building: "#1c2130", buildingTop: "#2a3041", label: "#c3c9d6", labelMuted: "#7b8294", halo: "#0d0f14",
    glowOpacity: 0.55, core: "#ffffff", fillOpacity: 0.25,
  },
  light: {
    bg: "#eef0f3", water: "#cfd9e6", park: "#dde7dc", road: "#ffffff", roadMajor: "#ffffff", roadOutline: "#d7dbe2",
    building: "#e1e4ea", buildingTop: "#d2d6de", label: "#2b303c", labelMuted: "#6b7282", halo: "#eef0f3",
    glowOpacity: 0.3, core: "#ffffff", fillOpacity: 0.3,
  },
};

const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];
const Z = (...stops) => ["interpolate", ["exponential", 1.4], ["zoom"], ...stops];

// `tiles` (optional): { url, minzoom, maxzoom, bounds } → curb layers read static vector tiles (source-layer "curbs")
// instead of the runtime GeoJSON source. Layer ids are identical either way so the UI code doesn't care.
export function buildStyle(theme, { colorExpr, hoverExpr, tiles, filter } = {}) {
  const P = PALETTES[theme] || PALETTES.dark;
  colorExpr = colorExpr || "#888";
  hoverExpr = hoverExpr || ["boolean", ["feature-state", "hover"], false];
  const curb = tiles ? { source: "curbs", "source-layer": "curbs" } : { source: "zones" };
  const curbSource = tiles
    ? { curbs: { type: "vector", tiles: [tiles.url], minzoom: tiles.minzoom, maxzoom: tiles.maxzoom, bounds: tiles.bounds, promoteId: { curbs: "id" } } }
    : { zones: { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "curb_zone_id" } };
  // Meters: a point layer inside the same tiles when the build included them, else the runtime GeoJSON source.
  const meter = tiles?.meters ? { source: "curbs", "source-layer": "meters" } : { source: "meters" };
  const withFilter = (f) => (filter ? ["all", f, filter] : f);
  return {
    version: 8,
    glyphs: OFM_GLYPHS,
    sources: {
      omt: { type: "vector", url: OFM_TILES, attribution: "© OpenStreetMap contributors, © OpenFreeMap" },
      ...curbSource,
      meters: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": P.bg } },
      { id: "park", type: "fill", source: "omt", "source-layer": "park", paint: { "fill-color": P.park } },
      { id: "landuse-green", type: "fill", source: "omt", "source-layer": "landuse", filter: ["in", "class", "grass", "cemetery", "wood", "pitch", "playground"], paint: { "fill-color": P.park, "fill-opacity": 0.7 } },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": P.water } },
      { id: "waterway", type: "line", source: "omt", "source-layer": "waterway", paint: { "line-color": P.water, "line-width": 1.5 } },

      // Streets, visible from city scale down to the block.
      { id: "road-outline", type: "line", source: "omt", "source-layer": "transportation", minzoom: 11,
        filter: ["!in", "class", "path", "rail", "transit", "ferry"], layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.roadOutline, "line-width": Z(11, 0.8, 14, 2.5, 16, 10, 19, 36) } },
      { id: "road-minor", type: "line", source: "omt", "source-layer": "transportation", minzoom: 11,
        filter: ["!in", "class", "path", "rail", "transit", "ferry", "motorway", "trunk", "primary", "secondary"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.road, "line-width": Z(11, 0.3, 14, 1.2, 16, 6, 19, 26) } },
      { id: "road-major", type: "line", source: "omt", "source-layer": "transportation",
        filter: ["in", "class", "motorway", "trunk", "primary", "secondary"], layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.roadMajor, "line-width": Z(9, 0.5, 14, 2.5, 16, 8, 19, 30) } },
      { id: "rail", type: "line", source: "omt", "source-layer": "transportation", filter: ["==", "class", "rail"], minzoom: 12,
        paint: { "line-color": P.roadOutline, "line-width": 1, "line-dasharray": [3, 3] } },

      // Flat building footprints (Google-Maps-2D style), fading in from z13.
      { id: "buildings", type: "fill", source: "omt", "source-layer": "building", minzoom: 13,
        paint: { "fill-color": P.building, "fill-outline-color": P.buildingTop, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, 0.9] } },

      // Curb lines: soft halo → colored line → thin bright core. Thin and bright at city scale, chunky up close.
      { id: "zone-fill", type: "fill", ...curb, filter: withFilter(["==", ["geometry-type"], "Polygon"]), paint: { "fill-color": colorExpr, "fill-opacity": P.fillOpacity } },
      { id: "zone-glow", type: "line", ...curb, ...(filter ? { filter } : {}), layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": colorExpr, "line-width": Z(9, 2, 13, 5, 16, 16, 19, 34), "line-blur": Z(9, 2, 13, 4, 16, 12, 19, 24), "line-opacity": ["case", hoverExpr, 0.95, P.glowOpacity] } },
      { id: "zone-line", type: "line", ...curb, ...(filter ? { filter } : {}), layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": colorExpr, "line-width": Z(9, 0.6, 13, 1.6, 16, 5, 19, 11), "line-opacity": 1 } },
      { id: "zone-core", type: "line", ...curb, ...(filter ? { filter } : {}), layout: { "line-cap": "round", "line-join": "round" }, minzoom: 15,
        paint: { "line-color": P.core, "line-width": Z(15, 0.6, 19, 3.5), "line-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 17, 0.75] } },

      { id: "meters-glow", type: "circle", ...meter, layout: { visibility: "none" },
        paint: { "circle-radius": Z(13, 5, 17, 14), "circle-color": "#3ea8ff", "circle-blur": 1, "circle-opacity": P.glowOpacity } },
      { id: "meters", type: "circle", ...meter, layout: { visibility: "none" },
        paint: { "circle-radius": Z(13, 2, 17, 5), "circle-color": P.core, "circle-stroke-color": "#3ea8ff", "circle-stroke-width": 2 } },

      // Labels on top of everything.
      { id: "road-label", type: "symbol", source: "omt", "source-layer": "transportation_name", minzoom: 14,
        layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 14], "text-letter-spacing": 0.05, "symbol-spacing": 350 },
        paint: { "text-color": P.label, "text-halo-color": P.halo, "text-halo-width": 1.6, "text-opacity": 0.9 } },
      { id: "place-neighbourhood", type: "symbol", source: "omt", "source-layer": "place", filter: ["in", "class", "neighbourhood", "suburb", "quarter"], minzoom: 12,
        layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": FONT, "text-size": 11, "text-transform": "uppercase", "text-letter-spacing": 0.25 },
        paint: { "text-color": P.labelMuted, "text-halo-color": P.halo, "text-halo-width": 1.2 } },
      { id: "place-city", type: "symbol", source: "omt", "source-layer": "place", filter: ["in", "class", "city", "town"], maxzoom: 14,
        layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": FONT_BOLD, "text-size": 14, "text-letter-spacing": 0.2 },
        paint: { "text-color": P.label, "text-halo-color": P.halo, "text-halo-width": 1.5 } },
    ],
  };
}

export const CURB_LAYERS = ["zone-fill", "zone-glow", "zone-line", "zone-core"];
export const LABEL_LAYERS = ["road-label", "place-neighbourhood", "place-city"];
export const METER_LAYERS = ["meters", "meters-glow"];
