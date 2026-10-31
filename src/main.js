import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { CATEGORIES, verdict, fmtRate, fmtSpan, dayKey, policyActive } from "./rules.js";
import { DEMO_ZONES, DEMO_POLICIES } from "./demo.js";
import { buildStyle, LABEL_LAYERS, METER_LAYERS, CURB_LAYERS } from "./basemap.js";
import { CODES, CATEGORY_OF, slotIndex, codeAt } from "./schedule.js";

const $ = (s) => document.querySelector(s);
const status = (msg, kind = "") => { const el = $("#status"); el.textContent = msg; el.className = `status ${kind}`; };

// ---------- state ----------
let policies = {};                 // curb_policy_id -> policy
const hidden = new Set();          // hidden categories
let day = dayKey(), hour = new Date().getHours();
let demoMode = false;

// Data mode. "tiles": prebuilt static vector tiles (scripts/build-tiles.js) — the fast path.
// "api": runtime GeoJSON from /api/zones — fallback when no tiles have been built.
let mode = "api";
let manifest = null;
const zones = new Map();           // api mode: curb_zone_id -> Feature
const fetchedTiles = new Set();
let cityLoaded = false;
const CITY_BBOX = [-71.1912, 42.2279, -70.9860, 42.3969];
const OVERVIEW_ZOOM = 13.2;

// ---------- theme ----------
function savedTheme() {
  try { const t = localStorage.getItem("theme"); if (t === "light" || t === "dark") return t; } catch {}
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
let theme = savedTheme();
document.documentElement.dataset.theme = theme;

// ---------- color expressions ----------
// api mode: features carry `cat` (recomputed in JS on every time change).
// tiles mode: features carry `sched` (168-char weekly schedule) — color is a GPU-side string slice.
const hoverExpr = ["boolean", ["feature-state", "hover"], false];
const catColors = Object.entries(CATEGORIES).flatMap(([k, v]) => [k, v.color]);
const codeColors = Object.entries(CATEGORIES).flatMap(([k, v]) => [CODES[k], v.color]);
function colorExprFor() {
  return mode === "tiles" ? ["match", codeAt(slotIndex(day, hour)), ...codeColors, "#7b8294"] : ["match", ["get", "cat"], ...catColors, "#7b8294"];
}
function filterExprFor() {
  if (mode !== "tiles" || !hidden.size) return null;
  return ["!", ["in", codeAt(slotIndex(day, hour)), ["literal", [...hidden].map((k) => CODES[k])]]];
}
function styleOpts() {
  const tiles = mode === "tiles" && manifest ? { url: location.origin + manifest.tile_url, minzoom: manifest.minzoom, maxzoom: manifest.maxzoom, bounds: manifest.bbox, meters: manifest.meters > 0 } : null;
  return { colorExpr: colorExprFor(), hoverExpr, tiles, filter: filterExprFor() };
}

// ---------- boot: decide the data mode before creating the map ----------
async function detectMode() {
  try {
    const r = await fetch("/data/manifest.json", { cache: "no-cache" });
    if (!r.ok) throw 0;
    manifest = await r.json();
    if (!manifest.tiles) throw 0;
    const pr = await fetch("/data/policies.json");
    policies = pr.ok ? await pr.json() : {};
    mode = "tiles";
  } catch { mode = "api"; }
}

await detectMode();

const map = new maplibregl.Map({
  container: "map",
  center: [-71.0589, 42.3601],
  zoom: 12.2,
  pitch: 0,
  bearing: 0,
  minZoom: 9,
  maxZoom: 20,
  maxPitch: 72,
  antialias: true,
  attributionControl: false,
  style: buildStyle(theme, styleOpts()),
});
window.__map = map; // handy in devtools / screenshot script
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), "bottom-right");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

let metersData = null;
function applyLayerToggles() {
  for (const id of METER_LAYERS) map.setLayoutProperty(id, "visibility", $("#showMeters").checked ? "visible" : "none");
  for (const id of LABEL_LAYERS) map.setLayoutProperty(id, "visibility", $("#showLabels").checked ? "visible" : "none");
  map.setLayoutProperty("buildings-3d", "visibility", $("#show3d").checked ? "visible" : "none");
}
// After any setStyle (theme switch) the GeoJSON sources come back empty: refill them.
map.on("style.load", () => {
  applyLayerToggles();
  repaint();
  if (metersData) map.getSource("meters")?.setData(metersData);
});

// Google-Maps-style camera: flat at city scale, tilts in as you get close to the blocks (unless 3D is off).
let autoTilt = true;
map.on("zoomend", () => {
  if (!autoTilt || !$("#show3d").checked) return;
  const z = map.getZoom();
  const want = z >= 15 ? 55 : z >= 14 ? 35 : 0;
  if (Math.abs(map.getPitch() - want) > 5) map.easeTo({ pitch: want, duration: 500 });
});
map.on("pitchstart", (e) => { if (e.originalEvent) autoTilt = false; });

map.on("load", () => {
  buildLegend();
  if (mode === "tiles") {
    status(`${manifest.zones.toLocaleString()} curb zones · tiles built ${new Date(manifest.built_at).toLocaleDateString()}`, "ok");
    map.on("error", (e) => { if (e.sourceId === "curbs" && e.error?.status === 404) status("Tile missing — rebuild with `npm run data`", "warn"); });
  } else {
    loadPolicies().then(() => refreshViewport());
    map.on("moveend", refreshViewport);
  }

  let hoverId = null;
  const hoverSource = mode === "tiles" ? { source: "curbs", sourceLayer: "curbs" } : { source: "zones" };
  map.on("mousemove", "zone-line", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const id = e.features[0].id;
    if (hoverId !== null && hoverId !== id) map.setFeatureState({ ...hoverSource, id: hoverId }, { hover: false });
    hoverId = id; map.setFeatureState({ ...hoverSource, id }, { hover: true });
  });
  map.on("mouseleave", "zone-line", () => {
    map.getCanvas().style.cursor = "";
    if (hoverId !== null) map.setFeatureState({ ...hoverSource, id: hoverId }, { hover: false });
    hoverId = null;
  });
  map.on("click", "zone-line", (e) => showPopup(e.features[0], e.lngLat));
  map.on("click", "zone-fill", (e) => showPopup(e.features[0], e.lngLat));
  map.on("click", (e) => { if (!map.queryRenderedFeatures(e.point, { layers: ["zone-line", "zone-fill"] }).length) hidePopup(); });
});

// ---------- api-mode data ----------
async function loadPolicies() {
  try {
    const r = await fetch("/api/policies");
    if (!r.ok) throw new Error(`policies ${r.status}`);
    policies = await r.json();
    if (!Object.keys(policies).length) throw new Error("policy list empty");
  } catch (e) { console.warn("policies unavailable, lazy-loading per zone", e); policies = {}; }
}

function tileKey(b) { return b.map((n) => n.toFixed(2)).join(","); }

async function refreshViewport() {
  if (map.getZoom() < OVERVIEW_ZOOM) return loadCity();
  const b = map.getBounds();
  const g = 0.01, f = (n) => Math.floor(n / g) * g, c = (n) => Math.ceil(n / g) * g;
  const bbox = [f(b.getWest()), f(b.getSouth()), c(b.getEast()), c(b.getNorth())];
  const key = tileKey(bbox);
  if (fetchedTiles.has(key)) { repaint(); return; }
  fetchedTiles.add(key);
  status("Fetching curb zones…", "busy");
  try {
    const r = await fetch(`/api/zones?bbox=${bbox.join(",")}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `zones ${r.status}`);
    const fc = await r.json();
    ingest(fc.features, true);
    const missing = new Set();
    for (const ft of fc.features) for (const pid of ft.properties.curb_policy_ids || []) if (!policies[pid]) missing.add(pid);
    if (missing.size) { const r2 = await fetch(`/api/policies?ids=${[...missing].join(",")}`); if (r2.ok) Object.assign(policies, await r2.json()); }
    demoMode = false;
    status(`${zones.size.toLocaleString()} curb zones loaded · updated ${fc.meta?.last_updated ? new Date(fc.meta.last_updated).toLocaleDateString() : "—"}`, "ok");
  } catch (e) { onApiError(e, "Couldn't load this area"); }
  repaint();
}

async function loadCity() {
  if (cityLoaded) { repaint(); return; }
  cityLoaded = true;
  status("Loading the whole city…", "busy");
  try {
    const r = await fetch(`/api/zones?bbox=${CITY_BBOX.join(",")}&lite=1`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `zones ${r.status}`);
    const fc = await r.json();
    ingest(fc.features, false);
    status(`${zones.size.toLocaleString()} curb zones citywide · updated ${fc.meta?.last_updated ? new Date(fc.meta.last_updated).toLocaleDateString() : "—"}`, "ok");
  } catch (e) { cityLoaded = false; onApiError(e, "Couldn't load the overview"); }
  repaint();
}

function ingest(features, overwrite) {
  for (const ft of features) {
    const id = ft.properties.curb_zone_id || ft.id;
    ft.id = id; ft.properties.curb_zone_id = id;
    if (overwrite || !zones.has(id)) zones.set(id, ft);
  }
}

function onApiError(e, what) {
  console.error(e);
  if (!zones.size) {
    demoMode = true;
    policies = { ...DEMO_POLICIES, ...policies };
    ingest(DEMO_ZONES.features, true);
    status(`City API unreachable (${e.message}). Showing demo curbs in Back Bay.`, "warn");
    map.flyTo({ center: [-71.081, 42.351], zoom: 16 });
  } else status(`${what}: ${e.message}`, "warn");
}

// Recolor for the current day/hour + legend toggles.
function repaint() {
  if (!map.getLayer("zone-line")) return;
  if (mode === "tiles") {
    const color = colorExprFor(), filter = filterExprFor();
    for (const id of CURB_LAYERS) {
      map.setPaintProperty(id, id === "zone-fill" ? "fill-color" : "line-color", color);
      if (id === "zone-fill") map.setFilter(id, filter ? ["all", ["==", ["geometry-type"], "Polygon"], filter] : ["==", ["geometry-type"], "Polygon"]);
      else map.setFilter(id, filter);
    }
    return;
  }
  const minute = hour * 60;
  const features = [];
  for (const ft of zones.values()) {
    const v = verdict(ft.properties, policies, day, minute);
    ft.properties.cat = v.category;
    if (!hidden.has(v.category)) features.push(ft);
  }
  map.getSource("zones")?.setData({ type: "FeatureCollection", features });
}

async function loadMeters() {
  status("Fetching parking meters…", "busy");
  try {
    const r = await fetch("/api/meters");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `meters ${r.status}`);
    const fc = await r.json();
    metersData = fc;
    map.getSource("meters").setData(fc);
    status(`${fc.features.length.toLocaleString()} meters loaded`, "ok");
  } catch (e) { status(`Meters unavailable: ${e.message}`, "warn"); }
}

// ---------- UI ----------
function buildLegend() {
  const ul = $("#legend");
  ul.innerHTML = "";
  for (const [k, v] of Object.entries(CATEGORIES)) {
    const li = document.createElement("li");
    li.innerHTML = `<button class="chip" data-cat="${k}" style="--c:${v.color}"><i></i>${v.label}</button>`;
    li.querySelector("button").addEventListener("click", (ev) => {
      hidden.has(k) ? hidden.delete(k) : hidden.add(k);
      ev.currentTarget.classList.toggle("off", hidden.has(k));
      repaint();
    });
    ul.appendChild(li);
  }
}

function hourLabel(h) { return `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`; }
function syncTime() { $("#hourLabel").value = hourLabel(hour); $("#day").value = day; $("#hour").value = hour; repaint(); }
$("#hour").addEventListener("input", (e) => { hour = +e.target.value; syncTime(); });
$("#day").addEventListener("change", (e) => { day = e.target.value; syncTime(); });
$("#nowBtn").addEventListener("click", () => { day = dayKey(); hour = new Date().getHours(); syncTime(); });
$("#showMeters").addEventListener("change", (e) => { applyLayerToggles(); if (e.target.checked && !metersData && !(mode === "tiles" && manifest.meters > 0)) loadMeters(); });
$("#showLabels").addEventListener("change", applyLayerToggles);
$("#show3d").addEventListener("change", (e) => {
  applyLayerToggles();
  autoTilt = e.target.checked;
  map.easeTo({ pitch: e.target.checked && map.getZoom() >= 14 ? 55 : 0, duration: 600 });
});
function setTheme(t) {
  theme = t;
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch {}
  $("#themeBtn").textContent = t === "dark" ? "Light" : "Dark";
  $("#themeBtn").setAttribute("aria-label", `Switch to ${t === "dark" ? "light" : "dark"} mode`);
  map.setStyle(buildStyle(t, styleOpts()), { diff: true });
}
$("#themeBtn").addEventListener("click", () => setTheme(theme === "dark" ? "light" : "dark"));
$("#themeBtn").textContent = theme === "dark" ? "Light" : "Dark";
$("#panelToggle").addEventListener("click", () => $("#panel").classList.toggle("collapsed"));
syncTime();

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// Normalize a clicked feature from either mode into zone props.
function zoneFromFeature(feature) {
  if (mode === "tiles") {
    const p = feature.properties;
    return { curb_zone_id: p.id, user_zone_id: p.zone, street_name: p.street, street_side: p.side, curb_policy_ids: p.pids ? p.pids.split(",") : [], sched: p.sched };
  }
  return zones.get(feature.id)?.properties || feature.properties;
}

function showPopup(feature, lngLat) {
  const p = zoneFromFeature(feature);
  const minute = hour * 60;
  // Prefer the precomputed schedule (it is exactly what's drawn); fall back to live resolution.
  const category = p.sched ? CATEGORY_OF[p.sched[slotIndex(day, hour)]] || "unknown" : verdict(p, policies, day, minute).category;
  const cat = CATEGORIES[category];
  const ids = p.curb_policy_ids || [];
  const rows = ids.map((id) => {
    const pol = policies[id]; if (!pol) return `<li class="dim">policy ${esc(id)} (not loaded)</li>`;
    const rule = (pol.rules || [])[0] || {};
    const on = policyActive(pol, day, minute);
    const bits = [esc(rule.activity || "?")];
    if (rule.max_stay) bits.push(`max ${rule.max_stay} min`);
    const rate = fmtRate(rule); if (rate) bits.push(rate);
    if (rule.user_classes?.length) bits.push(esc(rule.user_classes.join(", ")));
    const spans = (pol.time_spans || []).map(fmtSpan).join("; ") || "always";
    return `<li class="${on ? "on" : "dim"}"><b>${bits.join(" · ")}</b><br><span>${esc(spans)}</span>${pol.priority != null ? `<em>p${pol.priority}</em>` : ""}</li>`;
  }).join("");
  const title = [p.street_name, p.street_side ? `${p.street_side} side` : null].filter(Boolean).join(" · ") || "Curb zone";
  $("#popup").innerHTML = `
    <button class="x" aria-label="close">×</button>
    <div class="verdict" style="--c:${cat.color}"><span>${cat.label}</span><small>${cat.blurb}</small></div>
    <h3>${esc(title)}</h3>
    <div class="meta">${p.user_zone_id ? `Zone #${esc(p.user_zone_id)} · ` : ""}${$("#day").selectedOptions[0].text} ${hourLabel(hour)}${demoMode ? " · <b>demo data</b>" : ""}</div>
    <ul class="rules">${rows || "<li class='dim'>No policies attached.</li>"}</ul>`;
  $("#popup").classList.remove("hidden");
  $("#popup .x").onclick = hidePopup;
  const pt = map.project(lngLat);
  const el = $("#popup");
  const W = el.offsetWidth || 300, H = el.offsetHeight || 200;
  el.style.left = Math.min(Math.max(12, pt.x - W / 2), innerWidth - W - 12) + "px";
  el.style.top = Math.max(12, pt.y - H - 18) + "px";
}
function hidePopup() { $("#popup").classList.add("hidden"); }
map.on("move", hidePopup);
