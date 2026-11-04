// Basemap + overlay style, built per theme so the whole map can switch with map.setStyle(diff).
// Vector tiles: OpenFreeMap (OpenMapTiles schema, free, no key). Flat 2D.
//
// Progressive disclosure follows Google Maps (Google zoom N ≈ MapLibre zoom N-1, since Google counts 256px tiles):
//   ≤11  highways + arterials, city names           12  local streets fade in, neighborhoods, arterial names
//   13   secondary names, transit, water names      14  minor street names, faint buildings, park names
//   15   every street + alley named, one-way arrows 16+ roads at true width, sidewalks, full buildings
//   18+  house numbers; neighborhood names gone.    Label text stays ~11–13px at every zoom.
// Curbs behave like Google's traffic layer: arterials only when zoomed out, every street from 12, and from
// 14 each side of the street is drawn separately just inside the drawn road edge (line-offset).

export const OFM_TILES = "https://tiles.openfreemap.org/planet";
export const OFM_GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

export const PALETTES = {
  light: {
    bg: "#f3f4f1", water: "#9fd3f0", park: "#cdebd6", commercial: "#f8efdc",
    motorway: "#9fb0c8", major: "#b8c5d6", mid: "#cfd8e3", minor: "#ffffff", casing: "#d9dee5", rail: "#c4c8cf",
    building: "#e7e8ec", buildingLine: "#d9dbe1", label: "#5f6368", labelStrong: "#3c4043", halo: "#ffffff",
    arrow: "#9aa0a6", poi: "#70757a", transit: "#1a73e8", fillOpacity: 0.25, dimOpacity: 0.55,
  },
  dark: {
    bg: "#1e2024", water: "#16253a", park: "#1d3227", commercial: "#24252a",
    motorway: "#566174", major: "#454c58", mid: "#3a4049", minor: "#30343a", casing: "#1e2024", rail: "#3a3e45",
    building: "#2a2d33", buildingLine: "#33363d", label: "#c4c7cc", labelStrong: "#e8eaed", halo: "#16181b",
    arrow: "#7d828a", poi: "#a3a8ae", transit: "#8ab4f8", fillOpacity: 0.25, dimOpacity: 0.45,
  },
};

const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];
const FONT_ITALIC = ["Noto Sans Italic"];
const NAME = ["coalesce", ["get", "name:en"], ["get", "name"]];

// ---------- road geometry: metric widths at street zooms, legible minimums when zoomed out ----------
// Meters per pixel at Boston's latitude for MapLibre's 512px tiles.
const MPP0 = 78271.517 * Math.cos((42.35 * Math.PI) / 180);
export const mpp = (z) => MPP0 / 2 ** z;
// m: curb-to-curb width in meters (from measuring Boston curbs against OSM centerlines: 4–6 m each side).
// min: pixel floor by zoom so the network reads when zoomed out. from: zoom where the class fades in.
export const ROADS = {
  motorway:  { m: 13,   from: 5,    min: [[5, 0.6], [8, 1.2], [10, 2], [12, 3], [14, 4.5]], rank: 7 },
  trunk:     { m: 13,   from: 6,    min: [[6, 0.6], [8, 1.1], [10, 1.8], [12, 2.8], [14, 4.2]], rank: 6 },
  primary:   { m: 12,   from: 8,    min: [[8, 0.6], [10, 1.3], [12, 2.4], [14, 3.8]], rank: 5 },
  secondary: { m: 11.5, from: 9,    min: [[9, 0.5], [11, 1.1], [12, 1.8], [14, 3.2]], rank: 4 },
  tertiary:  { m: 11,   from: 10,   min: [[10, 0.5], [12, 1.4], [14, 3]], rank: 3 },
  minor:     { m: 9.5,  from: 11,   min: [[11, 0.3], [12, 0.8], [13, 1.3], [14, 2.2]], rank: 2 },
  busway:    { m: 7,    from: 12,   min: [[12, 0.5], [14, 1.5]], rank: 1 },
  service:   { m: 5.5,  from: 13,   min: [[13, 0.4], [14, 0.9], [15, 1.6]], rank: 1 },
};
const CLASSES = Object.keys(ROADS);
const DEFAULT_CLASS = "minor";
function minAt(cls, z) {
  const s = ROADS[cls].min;
  if (z <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) if (z <= s[i][0]) return s[i - 1][1] + ((s[i][1] - s[i - 1][1]) * (z - s[i - 1][0])) / (s[i][0] - s[i - 1][0]);
  return s[s.length - 1][1];
}
export const roadWidthPx = (cls, z) => Math.max(minAt(ROADS[cls] ? cls : DEFAULT_CLASS, z), (ROADS[cls] || ROADS[DEFAULT_CLASS]).m / mpp(z));
// Sidewalk/casing on each side, px.
const casingPx = (z) => (z < 13 ? 0 : z < 15 ? 0.5 : z < 17 ? 1 : z < 19 ? 2 : 3.5);
// Curb line width: thin like Google's traffic lines, growing toward a parking-lane width when very close.
const CURB_W = [[9, 0.6], [11, 0.9], [12, 1.1], [13, 1.5], [14, 2], [15, 2.5], [16, 3], [17, 4], [18, 5.5], [19, 8], [20, 12], [22, 24]];
const curbPx = (z) => { for (let i = 1; i < CURB_W.length; i++) if (z <= CURB_W[i][0]) return CURB_W[i - 1][1] + ((CURB_W[i][1] - CURB_W[i - 1][1]) * (z - CURB_W[i - 1][0])) / (CURB_W[i][0] - CURB_W[i - 1][0]); return CURB_W[CURB_W.length - 1][1]; };
// How far a curb sits from the centerline: just inside the road edge, never past the middle.
export const curbOffsetPx = (cls, z) => Math.max(0, roadWidthPx(cls, z) / 2 - curbPx(z) / 2 - (z >= 17 ? 1 : 0));

const ZOOMS = Array.from({ length: 18 }, (_, i) => i + 5); // 5..22
// interpolate over zoom with a per-class value at every integer zoom; base 2 keeps metric widths exact.
function byClassZoom(key, fn, zooms = ZOOMS) {
  const stops = zooms.flatMap((z) => [z, ["match", ["coalesce", ["get", key], ""], ...CLASSES.flatMap((c) => [c, +fn(c, z).toFixed(2)]), +fn(DEFAULT_CLASS, z).toFixed(2)]]);
  return ["interpolate", ["exponential", 2], ["zoom"], ...stops];
}
const fadeIn = (from) => (z) => Math.max(0, Math.min(1, (z - from + 0.5) / 1.5));
const roadOpacity = (k = 1) => ["interpolate", ["linear"], ["zoom"], ...Array.from({ length: 12 }, (_, i) => i + 5).flatMap((z) => [z, ["match", ["get", "class"], ...CLASSES.flatMap((c) => [c, +(k * fadeIn(ROADS[c].from)(z)).toFixed(2)]), 0]])];
const ROAD_FILTER = ["all", ["in", ["get", "class"], ["literal", CLASSES]], ["!=", ["get", "brunnel"], "tunnel"], ["!", ["in", ["get", "service"], ["literal", ["driveway", "parking_aisle"]]]]];
const TUNNEL_FILTER = ["all", ["in", ["get", "class"], ["literal", CLASSES]], ["==", ["get", "brunnel"], "tunnel"]];
const roadColor = (P) => ["match", ["get", "class"], ["motorway", "trunk"], P.motorway, "primary", P.major, ["secondary", "tertiary"], P.mid, P.minor];
// Bus stops and rail are handled elsewhere (or not at all — Google doesn't label bus stops at these zooms).
const POI_CLASSES = ["!", ["in", ["get", "class"], ["literal", ["railway", "bus", "parking", "bicycle_parking", "atm", "toilets", "drinking_water", "post", "fuel", "car"]]]];
const roadRank = ["match", ["get", "class"], ...CLASSES.flatMap((c) => [c, ROADS[c].rank]), 0];

// ---------- curbs ----------
// dimExpr: true for curbs with no usable rule. Like roads without traffic data on Google, they're simply not
// drawn until street level, then only as a faint line, so the known rules carry the picture.
// Disclosure by zoom: <12 arterials only and no stubs; 12–14 every street, stubs (<20 m, mostly hydrants)
// hidden; ≥14 everything, split per side; ≥15 no-data curbs appear faintly.
// gateExpr: a 0–1 multiplier per curb from the UI — 0 for categories filtered out in the legend.
// Level of detail. Zoomed out, a single curb is too small to read or click, and drawing tens of thousands of them is
// what made zooming slow, so curbs only appear from CURB_FADE_ZOOM, fully drawn and clickable by CURB_ZOOM.
// "No data" curbs (never anything else) join, dimmed, at NO_DATA_ZOOM.
export const CURB_FADE_ZOOM = 12, CURB_ZOOM = 12.3, NO_DATA_ZOOM = 14;
// `bind` (optional): ["name", expr, …] — variables the other expressions use as ["var", name] (the curb's category
// looked up once per property instead of once per use in the JSON). Each paint value that refers to one is
// wrapped in a single "let".
export function curbPaint(theme, { colorExpr = "#888", dimExpr = false, gateExpr = 1, bind = null } = {}) {
  const P = PALETTES[theme] || PALETTES.dark;
  const g = (v) => (gateExpr === 1 ? v : ["*", gateExpr, v]);
  const shown = ["interpolate", ["linear"], ["zoom"],
    CURB_FADE_ZOOM, 0,
    CURB_ZOOM, g(["case", dimExpr, 0, 1]),
    NO_DATA_ZOOM - 0.01, g(["case", dimExpr, 0, 1]),
    NO_DATA_ZOOM, g(["case", dimExpr, P.dimOpacity, 1])];
  const side = ["coalesce", ["get", "side"], 0];
  const width = (k) => ["interpolate", ["exponential", 2], ["zoom"], ...CURB_W.flatMap(([z, w]) => [z, ["case", dimExpr, Math.max(0.6, +(w * 0.6 * k).toFixed(2)), +(w * k).toFixed(2)]])];
  const offset = ["interpolate", ["exponential", 2], ["zoom"], ...ZOOMS.filter((z) => z >= 9).flatMap((z) => [z, ["*", side, byClassZoom("rc", curbOffsetPx, [z]).at(-1)]])];
  const usesVar = (v) => JSON.stringify(v).includes('"var"');
  const bound = (v) => (bind && usesVar(v) ? ["let", ...bind, v] : v);
  const layers = {
    "zone-fill": { "fill-color": colorExpr, "fill-opacity": g(["case", dimExpr, P.fillOpacity * 0.4, P.fillOpacity]) },
    "zone-line": { "line-color": colorExpr, "line-opacity": shown, "line-width": width(1), "line-offset": offset },
  };
  for (const props of Object.values(layers)) for (const k of Object.keys(props)) props[k] = bound(props[k]);
  return layers;
}

// `tiles` (optional): { url, minzoom, maxzoom, bounds } → curb layers read static vector tiles (source-layer "curbs")
// instead of the runtime GeoJSON source. Layer ids are identical either way so the UI code doesn't care.
export function buildStyle(theme, { colorExpr, dimExpr, gateExpr, bind, tiles, filter } = {}) {
  const P = PALETTES[theme] || PALETTES.dark;
  const paint = curbPaint(theme, { colorExpr: colorExpr || "#888", dimExpr, gateExpr, bind });
  const curb = tiles ? { source: "curbs", "source-layer": "curbs" } : { source: "zones" };
  const curbSource = tiles
    ? { curbs: { type: "vector", tiles: [tiles.url], minzoom: tiles.minzoom, maxzoom: tiles.maxzoom, bounds: tiles.bounds } }
    : { zones: { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "curb_zone_id" } };
  // Meters: a point layer inside the same tiles when the build included them, else the runtime GeoJSON source.
  const meter = tiles?.meters ? { source: "curbs", "source-layer": "meters" } : { source: "meters" };
  const withFilter = (f) => (filter ? ["all", f, filter] : f);
  const omt = (id, type, layer, rest) => ({ id, type, source: "omt", "source-layer": layer, ...rest });
  const lineLayout = { "line-cap": "round", "line-join": "round" };
  const roadLabel = (id, minzoom, classes, size) => omt(id, "symbol", "transportation_name", {
    minzoom, filter: ["in", ["get", "class"], ["literal", classes]],
    layout: { "symbol-placement": "line", "text-field": NAME, "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], minzoom, size, 18, size + 2.5], "text-max-angle": 30, "symbol-spacing": 280, "text-padding": 4 },
    paint: { "text-color": P.label, "text-halo-color": P.halo, "text-halo-width": 1.5 },
  });
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
      omt("landuse-commercial", "fill", "landuse", { minzoom: 12, filter: ["in", ["get", "class"], ["literal", ["commercial", "retail"]]], paint: { "fill-color": P.commercial, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0, 14, 1] } }),
      omt("park", "fill", "park", { paint: { "fill-color": P.park } }),
      omt("landuse-green", "fill", "landuse", { filter: ["in", ["get", "class"], ["literal", ["grass", "cemetery", "pitch", "playground"]]], paint: { "fill-color": P.park, "fill-opacity": 0.8 } }),
      omt("landcover-green", "fill", "landcover", { filter: ["in", ["get", "class"], ["literal", ["grass", "wood"]]], paint: { "fill-color": P.park, "fill-opacity": 0.8 } }),
      omt("water", "fill", "water", { paint: { "fill-color": P.water } }),
      omt("waterway", "line", "waterway", { paint: { "line-color": P.water, "line-width": 1.5 } }),

      // Buildings: faint from 14, crisp with outlines by 16 (Google 15 → 17).
      omt("buildings", "fill", "building", { minzoom: 14, paint: { "fill-color": P.building, "fill-outline-color": P.buildingLine, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 14.5, 0.5, 16, 1] } }),

      // Roads: tunnels faint, then sidewalks/casing, then fills ranked so arterials cross over local streets.
      omt("road-tunnel", "line", "transportation", { filter: TUNNEL_FILTER, layout: lineLayout,
        paint: { "line-color": roadColor(P), "line-width": byClassZoom("class", roadWidthPx), "line-opacity": roadOpacity(0.35) } }),
      omt("road-casing", "line", "transportation", { minzoom: 13, filter: ROAD_FILTER, layout: { ...lineLayout, "line-sort-key": roadRank },
        paint: { "line-color": P.casing, "line-width": byClassZoom("class", (c, z) => roadWidthPx(c, z) + 2 * casingPx(z)), "line-opacity": roadOpacity() } }),
      omt("road", "line", "transportation", { filter: ROAD_FILTER, layout: { ...lineLayout, "line-sort-key": roadRank },
        paint: { "line-color": roadColor(P), "line-width": byClassZoom("class", roadWidthPx), "line-opacity": roadOpacity() } }),
      omt("rail", "line", "transportation", { minzoom: 12, filter: ["all", ["==", ["get", "class"], "rail"], ["!=", ["get", "brunnel"], "tunnel"]],
        paint: { "line-color": P.rail, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 16, 1.5], "line-dasharray": [4, 3] } }),

      // Curbs sit on the roads, under all labels.
      { id: "zone-fill", type: "fill", ...curb, minzoom: CURB_FADE_ZOOM, filter: withFilter(["==", ["geometry-type"], "Polygon"]), paint: paint["zone-fill"] },
      { id: "zone-line", type: "line", ...curb, minzoom: CURB_FADE_ZOOM, ...(filter ? { filter } : {}), layout: { "line-cap": "round", "line-join": "round" }, paint: paint["zone-line"] },

      { id: "meters", type: "circle", ...meter, minzoom: 15, layout: { visibility: "none" },
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 2.5, 19, 6], "circle-color": "#1a73e8", "circle-stroke-color": P.halo, "circle-stroke-width": 1.5 } },

      // One-way arrows from 15 (Google 16), drawn as glyphs along the line.
      omt("oneway", "symbol", "transportation", { minzoom: 15, filter: ["all", ["in", ["get", "oneway"], ["literal", [1, -1]]], ["in", ["get", "class"], ["literal", CLASSES]]],
        layout: { "symbol-placement": "line", "symbol-spacing": 120, "text-field": ["case", ["==", ["get", "oneway"], -1], "←", "→"], "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 15, 9, 19, 13], "text-keep-upright": false, "text-allow-overlap": false, "text-padding": 2 },
        paint: { "text-color": P.arrow, "text-opacity": 0.9 } }),

      // Labels: roads by class, finer streets as you zoom in.
      roadLabel("road-label-major", 11, ["motorway", "trunk", "primary"], 11),
      roadLabel("road-label-mid", 13, ["secondary", "tertiary"], 10.5),
      roadLabel("road-label-minor", 14, ["minor", "busway"], 10.5),
      roadLabel("road-label-service", 15, ["service"], 10),
      omt("housenumber", "symbol", "housenumber", { minzoom: 18, layout: { "text-field": ["get", "housenumber"], "text-font": FONT, "text-size": 10, "text-padding": 3 }, paint: { "text-color": P.poi, "text-halo-color": P.halo, "text-halo-width": 1 } }),

      ...["Point", "LineString"].map((g) => omt(`water-label-${g === "Point" ? "point" : "line"}`, "symbol", "water_name", { minzoom: 12, filter: ["==", ["geometry-type"], g],
        layout: { "text-field": NAME, "text-font": FONT_ITALIC, "text-size": ["interpolate", ["linear"], ["zoom"], 12, 11, 16, 13], "text-letter-spacing": 0.05, "symbol-placement": g === "Point" ? "point" : "line" },
        paint: { "text-color": P.label, "text-halo-color": P.halo, "text-halo-width": 1.2 } })),

      omt("park-label", "symbol", "park", { minzoom: 14, filter: ["has", "name"], layout: { "text-field": NAME, "text-font": FONT, "text-size": 11, "text-max-width": 8, "text-padding": 6 }, paint: { "text-color": P.label, "text-halo-color": P.halo, "text-halo-width": 1.2 } }),
      omt("poi-transit", "symbol", "poi", { minzoom: 13, filter: ["all", ["==", ["get", "class"], "railway"], ["in", ["get", "subclass"], ["literal", ["station", "subway", "halt", "tram_stop"]]]],
        layout: { "text-field": ["format", "■ ", { "text-color": P.transit }, NAME, {}], "text-font": FONT, "text-size": 11, "text-anchor": "left", "text-offset": [0.3, 0], "text-optional": true, "text-padding": 4 },
        paint: { "text-color": P.labelStrong, "text-halo-color": P.halo, "text-halo-width": 1.2 } }),
      // POIs: only the most prominent from 14, the rest from 16 — muted so they never compete with curb colors.
      omt("poi-major", "symbol", "poi", { minzoom: 14, filter: ["all", ["<=", ["get", "rank"], 2], POI_CLASSES],
        layout: { "text-field": ["format", "● ", { "text-color": P.arrow }, NAME, {}], "text-font": FONT, "text-size": 10.5, "text-max-width": 9, "text-anchor": "left", "text-offset": [0.3, 0], "text-padding": 6, "symbol-sort-key": ["get", "rank"] },
        paint: { "text-color": P.poi, "text-halo-color": P.halo, "text-halo-width": 1.2 } }),
      omt("poi-minor", "symbol", "poi", { minzoom: 16, filter: ["all", [">", ["get", "rank"], 2], POI_CLASSES],
        layout: { "text-field": ["format", "● ", { "text-color": P.arrow }, NAME, {}], "text-font": FONT, "text-size": 10, "text-max-width": 9, "text-anchor": "left", "text-offset": [0.3, 0], "text-padding": 6, "symbol-sort-key": ["get", "rank"] },
        paint: { "text-color": P.poi, "text-halo-color": P.halo, "text-halo-width": 1.2 } }),

      // Places: neighborhoods 12–17 (gone at street level), cities/towns until 14.
      omt("place-neighbourhood", "symbol", "place", { minzoom: 12, maxzoom: 17, filter: ["in", ["get", "class"], ["literal", ["neighbourhood", "suburb", "quarter"]]],
        layout: { "text-field": NAME, "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 16, 12], "text-transform": "uppercase", "text-letter-spacing": 0.15, "text-max-width": 7, "text-padding": 8 },
        paint: { "text-color": P.label, "text-halo-color": P.halo, "text-halo-width": 1.5 } }),
      omt("place-city", "symbol", "place", { maxzoom: 14, filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
        layout: { "text-field": NAME, "text-font": FONT_BOLD, "text-size": ["interpolate", ["linear"], ["zoom"], 8, 12, 13, 16] },
        paint: { "text-color": P.labelStrong, "text-halo-color": P.halo, "text-halo-width": 1.8 } }),
    ],
  };
}

export const CURB_LAYERS = ["zone-fill", "zone-line"];
export const LABEL_LAYERS = ["road-label-major", "road-label-mid", "road-label-minor", "road-label-service"];
export const METER_LAYERS = ["meters"];
