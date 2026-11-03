import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { CATEGORIES, verdict, daySchedule, policyActive, fmtSpanShort, fmtTime, fmtRate, fmtSpan, dayKey, isRealPolicy, isStreetCleaning, ruleOf, collapsePolicies, overriddenBy, reasonOf, catColor, shade, cityHoliday, stayWindow, evaluateStay } from "./rules.js";
import { DEMO_ZONES, DEMO_POLICIES } from "./demo.js";
import { buildStyle, curbPaint, LABEL_LAYERS, METER_LAYERS, CURB_LAYERS, CURB_FADE_ZOOM, CURB_ZOOM, NO_DATA_ZOOM } from "./basemap.js";
import { CODES, CATEGORY_OF, SLOT_MIN } from "./schedule.js";

const $ = (s) => document.querySelector(s);
const status = (msg, kind = "") => { const el = $("#status"); el.textContent = msg; el.className = `status ${kind}`; };
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// ---------- state ----------
let policies = {};                 // curb_policy_id -> policy
let rulesets = [];                 // tiles: rs -> "id,id,…" (every distinct set of rule ids a curb carries)
const selected = new Set();        // legend: empty = show every rule; otherwise only these categories
// Time: by default the map follows the clock ("live"). Picking a day or time in the time panel pins it.
let live = true;
let pinned = null;                 // Date, when not live
// Curbs are graded for a driver with no resident permit and no disability placard.
const PROFILE = { permit: false, placard: false };
const startTime = () => (live ? new Date() : new Date(pinned));
const minuteOf = (d) => d.getHours() * 60 + d.getMinutes();
const holidayName = () => cityHoliday(startTime());
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
// Follows the device's light/dark setting, live. The button overrides it for this visit only.
const systemDark = matchMedia("(prefers-color-scheme: dark)");
let theme = systemDark.matches ? "dark" : "light";
document.documentElement.dataset.theme = theme;

// ---------- expressions ----------
// Every curb is graded in the browser for the actual date and stay (street cleaning runs only some weeks of the
// month; Sundays and holidays free the meters). Curbs sharing a set of rules grade the same, so in tiles mode each
// rule set (`rs`) is graded once and the results go into the style as two arrays indexed by `rs`: `grades.cat`
// (index into CATS: the category drawn — the most restrictive one met during a stay) and `grades.fit` (index into
// FITS). The style looks them up per feature with ["at", rs, …], so panning and zooming run no JS and keep no
// per-feature state. Small integers keep each table ~20 KB; an array lookup is O(1) where slicing a long string
// (the first version) copied the whole string per curb per expression, seconds of worker time per tile.
// api mode writes the same results into each feature's `cat`/`fit` properties.
const CATS = Object.keys(CODES);
let grades = { key: "", cat: [] };
// Includes the data mode and rule-set count, so grades made before the data arrived are never reused.
const gradeKey = () => `${mode}|${rulesets.length}|${Math.floor(startTime().getTime() / 60000)}`;
// (rs and the tables come from the same build — every URL is versioned — but an out-of-range index would make
// MapLibre fall back to black, so it's guarded.)
const lookup = (table, values, fallback) => ["case", ["<", ["coalesce", ["get", "rs"], table.length], table.length],
  ["at", ["at", ["get", "rs"], ["literal", table]], ["literal", values]], fallback];
// Not graded yet (or api mode): the weekly-dominant category baked into the tile.
const domCat = ["match", ["coalesce", ["get", "dom"], "u"], ...Object.entries(CODES).flatMap(([k, c]) => [c, k]), "unknown"];
const catKey = () => (mode !== "tiles" ? ["coalesce", ["get", "cat"], "unknown"] : grades.cat.length ? lookup(grades.cat, CATS, "unknown") : domCat);
// The expressions below refer to ["var","cat"]; curbPaint binds it once per paint property.
const CAT = ["var", "cat"];
const highlightExpr = ["any", ["boolean", ["feature-state", "hover"], false], ["boolean", ["feature-state", "selected"], false]];
function colorExprFor() {
  const key = CAT, fallback = catColor("unknown", theme);
  const pairs = (f) => Object.keys(CATEGORIES).flatMap((k) => [k, f(catColor(k, theme))]);
  return ["case", highlightExpr, ["match", key, ...pairs((c) => shade(c, theme)), shade(fallback, theme)], ["match", key, ...pairs((c) => c), fallback]];
}
function gateExprFor() {
  const picked = [...selected, ...(selected.has("accessible") ? ["accessible_permit"] : [])];
  return selected.size ? ["case", ["in", CAT, ["literal", picked]], 1, 0] : 1;
}
const paintOpts = () => ({
  colorExpr: colorExprFor(), dimExpr: ["==", CAT, "unknown"], gateExpr: gateExprFor(), bind: ["cat", catKey()],
});
function styleOpts() {
  const tiles = mode === "tiles" && manifest ? { url: location.origin + manifest.tile_url, minzoom: manifest.minzoom, maxzoom: manifest.maxzoom, bounds: manifest.bbox, meters: manifest.meters > 0 } : null;
  return { ...paintOpts(), tiles };
}

// ---------- boot: decide the data mode before creating the map ----------
async function detectMode() {
  try {
    const r = await fetch("/data/manifest.json", { cache: "no-cache" });
    if (!r.ok) throw 0;
    manifest = await r.json();
    if (!manifest.tiles) throw 0;
    // Versioned like the tiles, so a browser can't pair this build's tiles with another build's rules.
    const v = manifest.version ? `?v=${manifest.version}` : "";
    const [pr, rr] = await Promise.all(["policies", "rulesets"].map((f) => fetch(`/data/${f}.json${v}`)));
    policies = pr.ok ? await pr.json() : {};
    rulesets = rr.ok ? await rr.json() : [];
    mode = "tiles";
    gradeAll();
  } catch { mode = "api"; }
}

await detectMode();
// [w, s, e, n] grown by a margin (degrees), as MapLibre's [[w, s], [e, n]].
function padBounds([w, s, e, n], dx = 0.06, dy = 0.04) { return [[w - dx, s - dy], [e + dx, n + dy]]; }

const map = new maplibregl.Map({
  container: "map",
  center: [-71.07, 42.35], // central Boston, at a zoom where curbs are drawn (they start at CURB_FADE_ZOOM)
  zoom: 12.6,
  // Boston only: the view can't leave the curb data's area (plus a margin), which also caps how far out you can
  // zoom — about the whole city on a laptop screen. minZoom is a floor for very small screens.
  maxBounds: padBounds(mode === "tiles" && manifest?.bbox ? manifest.bbox : CITY_BBOX),
  minZoom: 10,
  maxZoom: 20,
  maxPitch: 0,          // 2D only
  pitchWithRotate: false,
  dragRotate: false,
  touchPitch: false,
  antialias: true,
  attributionControl: false,
  style: buildStyle(theme, styleOpts()),
});
window.__map = map; // handy in devtools / screenshot script
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), "bottom-right");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

let metersData = null;
function applyLayerToggles() {
  for (const id of METER_LAYERS) map.setLayoutProperty(id, "visibility", $("#showMeters").checked ? "visible" : "none");
  for (const id of LABEL_LAYERS) map.setLayoutProperty(id, "visibility", $("#showLabels").checked ? "visible" : "none");
}
// After any setStyle (theme switch) the GeoJSON sources come back empty and feature-state is gone: refill both.
map.on("style.load", () => {
  applyLayerToggles();
  repaint();
  if (metersData) map.getSource("meters")?.setData(metersData);
});

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
  // Curb lines are only a few px wide, so hit-test with a tolerance box like Google does, skipping curbs the
  // current zoom or legend hides (anything below CURB_ZOOM, no-data below NO_DATA_ZOOM).
  map.on("mousemove", (e) => {
    const f = pickCurb(e.point);
    map.getCanvas().style.cursor = f ? "pointer" : "";
    const id = f ? f.id : null;
    if (hoverId !== null && hoverId !== id) map.setFeatureState({ ...curbSource(), id: hoverId }, { hover: false });
    hoverId = id;
    if (id !== null) map.setFeatureState({ ...curbSource(), id }, { hover: true });
  });
  map.on("click", (e) => { const f = pickCurb(e.point); if (phone.matches) setSheet(false); f ? showPopup(f, e.lngLat) : hidePopup(); });
});

const curbSource = () => (mode === "tiles" ? { source: "curbs", sourceLayer: "curbs" } : { source: "zones" });

// The category a feature is drawn as right now (matches catKey()).
function drawnCat(f) {
  const p = f.properties;
  if (mode !== "tiles") return zones.get(f.id)?.properties.cat || p.cat || "unknown";
  return grades.cat.length ? CATS[grades.cat[p.rs]] || "unknown" : CATEGORY_OF[p.dom] || "unknown";
}
const HIT_PX = 7;
function shownAtZoom(f) {
  const z = map.getZoom(), cat = drawnCat(f);
  if (z < CURB_ZOOM || (cat === "unknown" && z < NO_DATA_ZOOM)) return false; // zoomed out, curbs aren't drawn
  if (selected.size && !selected.has(cat === "accessible_permit" ? "accessible" : cat)) return false;
  return true;
}
function pickCurb(pt) {
  if (map.getZoom() < CURB_ZOOM) return null;
  const layers = ["zone-line", "zone-fill"].filter((l) => map.getLayer(l));
  // Grow the box until something visible is under it, so the nearest curb wins over a neighbor.
  for (const r of [0, 2, 4, HIT_PX]) {
    const hits = map.queryRenderedFeatures(r ? [[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]] : [pt.x, pt.y], { layers }).filter(shownAtZoom);
    if (hits.length) return hits[0];
  }
  return null;
}

let selectedId = null;
function select(id) {
  if (selectedId !== null) map.setFeatureState({ ...curbSource(), id: selectedId }, { selected: false });
  selectedId = id ?? null;
  if (selectedId !== null) map.setFeatureState({ ...curbSource(), id: selectedId }, { selected: true });
}

// ---------- grading ----------
// Grades the chosen moment. Only reruns when the time changes.
function gradeAll() {
  const key = gradeKey();
  if (grades.key === key) return false;
  const steps = stayWindow(startTime(), 1), grade = (pids) => evaluateStay({ curb_policy_ids: pids ? pids.split(",") : [] }, policies, steps, PROFILE);
  if (mode === "tiles") {
    const catIx = Object.fromEntries(CATS.map((c, i) => [c, i])), unknown = catIx.unknown;
    const cat = rulesets.map((pids) => catIx[grade(pids).worst] ?? unknown);
    grades = { key, cat };
  } else {
    const byRules = new Map();
    for (const ft of zones.values()) {
      const pids = (ft.properties.curb_policy_ids || []).join(",");
      let r = byRules.get(pids); if (!r) byRules.set(pids, (r = grade(pids)));
      ft.properties.cat = r.worst;
    }
    grades = { key, cat: [] };
  }
  return true;
}

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

// Recolor for the chosen time/stay + legend selection. setPaintProperty is a no-op when the expression is unchanged
// (e.g. a live tick whose grades come out the same), so this only re-lays-out tiles when the colors really move.
function repaint() {
  if (!map.getLayer("zone-line")) return;
  if (mode !== "tiles") {
    grades.key = ""; // new zones may have arrived
    gradeAll();
    map.getSource("zones")?.setData({ type: "FeatureCollection", features: [...zones.values()] });
  } else gradeAll();
  const paint = curbPaint(theme, paintOpts());
  for (const id of CURB_LAYERS) for (const [k, v] of Object.entries(paint[id])) map.setPaintProperty(id, k, v);
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

// ---------- UI: legend ----------
// Every rule shows by default. Clicking a chip shows only that rule; more clicks add to the selection; clearing the
// last one shows everything again.
function buildLegend() {
  const ul = $("#legend");
  ul.innerHTML = "";
  for (const [k, v] of Object.entries(CATEGORIES)) {
    if (v.legend === false) continue; // shown under a related chip (accessible_permit → Accessible)
    const li = document.createElement("li");
    li.innerHTML = `<button class="chip" type="button" data-cat="${k}" style="--c:${catColor(k, theme)}"><i></i>${v.label}</button>`;
    li.querySelector("button").addEventListener("click", () => { selected.has(k) ? selected.delete(k) : selected.add(k); syncLegend(); repaint(); });
    ul.appendChild(li);
  }
  syncLegend();
}
function syncLegend() {
  for (const b of document.querySelectorAll("#legend .chip")) {
    const on = selected.has(b.dataset.cat);
    b.classList.toggle("on", on);
    b.classList.toggle("off", selected.size > 0 && !on);
    b.setAttribute("aria-pressed", on);
  }
}

// ---------- UI: time ----------
// A day picker and a time-of-day slider. The map follows the clock until either is touched; "Now" goes back to it.
const fmtClock = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const DAYS = 7;
const dayOffset = (t) => Math.round((midnight(t) - midnight(new Date())) / 86400000);
const dayName = (t, i = dayOffset(t)) => (i === 0 ? "Today" : i === 1 ? "Tomorrow" : fmtDay(t).split(",")[0]);
let builtFor = 0;
// Day picker: a button and a listbox of the next DAYS days (a native <select> can't be styled to match).
function buildTimeControls() {
  const today = midnight(new Date());
  builtFor = today.getTime();
  $("#dayList").innerHTML = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    return `<li role="option" id="day-${i}" data-i="${i}" aria-selected="false">${i < 2 ? `${dayName(d, i)}<small>${fmtDay(d).split(", ")[1] || ""}</small>` : fmtDay(d)}</li>`;
  }).join("");
}
function pin(dayIdx, minute) {
  const now = new Date();
  live = false;
  pinned = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayIdx, 0, minute); // DST-safe
}
const dayIdx = () => Math.max(0, Math.min(DAYS - 1, dayOffset(startTime())));
function setDayList(open) {
  $("#dayList").hidden = !open;
  $("#dayBtn").setAttribute("aria-expanded", String(open));
  if (open) { highlightDay(dayIdx()); $("#dayList").focus(); }
}
let activeDay = 0;
function highlightDay(i) {
  activeDay = (i + DAYS) % DAYS;
  for (const li of $("#dayList").children) li.classList.toggle("active", +li.dataset.i === activeDay);
  $("#dayList").setAttribute("aria-activedescendant", `day-${activeDay}`);
}
function pickDay(i) { pin(i, minuteOf(startTime())); setDayList(false); $("#dayBtn").focus(); syncTime(); }
$("#dayBtn").addEventListener("click", () => setDayList($("#dayList").hidden));
$("#dayList").addEventListener("click", (e) => { const li = e.target.closest("li[data-i]"); if (li) pickDay(+li.dataset.i); });
$("#dayList").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); highlightDay(activeDay + (e.key === "ArrowDown" ? 1 : -1)); }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickDay(activeDay); }
  else if (e.key === "Escape" || e.key === "Tab") { setDayList(false); $("#dayBtn").focus(); }
});
document.addEventListener("pointerdown", (e) => { if (!$("#dayList").hidden && !e.target.closest(".daypick")) setDayList(false); });
let sliderFrame = 0;
$("#timeSlider").addEventListener("input", (e) => {
  pin(dayIdx(), +e.target.value);
  cancelAnimationFrame(sliderFrame);
  sliderFrame = requestAnimationFrame(syncTime); // one recolor per frame while dragging
});
function syncTime() {
  if (midnight(new Date()).getTime() !== builtFor) buildTimeControls(); // "Today" moved on
  const t = startTime(), hol = holidayName(), day = dayKey(t);
  $("#whenLabel").textContent = `${dayName(t)} ${fmtClock(t)}`;
  $("#dateNote").textContent = hol ? `${hol} — meters free` : day === "sun" ? "Meters free on Sundays" : "";
  const di = dayIdx(), opt = $(`#day-${di}`);
  $("#dayLabel").textContent = opt ? opt.firstChild.textContent : dayName(t);
  for (const li of $("#dayList").children) li.setAttribute("aria-selected", String(+li.dataset.i === di));
  $("#timeSlider").value = String(minuteOf(t));
  $("#sliderOut").textContent = fmtClock(t);
  $("#nowBtn").hidden = live;
  repaint();
}
$("#whenBtn").addEventListener("click", () => {
  if (phone.matches) return setSheet(!sheetOpen()); // phones: the chip opens the settings sheet, where the time controls are always open
  const open = $("#whenPanel").hidden;
  $("#whenPanel").hidden = !open;
  $("#whenBtn").setAttribute("aria-expanded", String(open));
});
$("#nowBtn").addEventListener("click", () => { live = true; pinned = null; syncTime(); });
// Live mode keeps up with the clock: relabel every 15 s, recolor when the half hour moves.
let lastTick = "";
setInterval(() => {
  if (!live) return;
  const t = new Date(), tick = `${dayKey(t)}${Math.floor(minuteOf(t) / SLOT_MIN)}`;
  if (tick !== lastTick) { lastTick = tick; syncTime(); return; }
  $("#whenLabel").textContent = `${dayName(t)} ${fmtClock(t)}`;
  $("#sliderOut").textContent = fmtClock(t);
  $("#timeSlider").value = String(minuteOf(t));
}, 15000);

// ---------- UI: layers, theme, panel ----------
$("#showMeters").addEventListener("change", (e) => { applyLayerToggles(); if (e.target.checked && !metersData && !(mode === "tiles" && manifest.meters > 0)) loadMeters(); });
$("#showLabels").addEventListener("change", applyLayerToggles);
function setTheme(t) {
  theme = t;
  document.documentElement.dataset.theme = t;
  $("#themeBtn").textContent = t === "dark" ? "Light" : "Dark";
  $("#themeBtn").setAttribute("aria-label", `Switch to ${t === "dark" ? "light" : "dark"} mode`);
  map.setStyle(buildStyle(t, styleOpts()), { diff: true });
  buildLegend();
}
$("#themeBtn").addEventListener("click", () => setTheme(theme === "dark" ? "light" : "dark"));
systemDark.addEventListener("change", (e) => { if ((e.matches ? "dark" : "light") !== theme) setTheme(e.matches ? "dark" : "light"); });
$("#themeBtn").textContent = theme === "dark" ? "Light" : "Dark";
$("#panelToggle").addEventListener("click", () => $("#panel").classList.toggle("collapsed"));
// Phones: the time chip and legend move from the panel into the chip row under the search pill, and the panel becomes
// a settings sheet opened by the slider button or the time chip (tap or drag its handle down to close).
const phone = matchMedia("(max-width: 640px)");
function placeControls() {
  if (phone.matches) { $("#chipRow").append($("#whenBtn"), $("#legend")); return; }
  $(".card.when").prepend($("#whenBtn"));
  $(".rules-card h2").after($("#legend"));
  setSheet(false);
}
const sheetOpen = () => $("#panel").classList.contains("open");
function setSheet(open) {
  $("#panel").classList.toggle("open", open);
  $("#settingsBtn").setAttribute("aria-expanded", String(open));
  $("#sheetHandle").setAttribute("aria-expanded", String(open));
  $("#sheetHandle").setAttribute("aria-label", open ? "Close settings" : "Open settings");
  if (!open) $("#panel").scrollTop = 0;
  syncSheetHeight();
}
$("#settingsBtn").addEventListener("click", () => setSheet(!sheetOpen()));
{
  const h = $("#sheetHandle"), panel = $("#panel");
  let y0 = null, dy = 0;
  h.addEventListener("pointerdown", (e) => { y0 = e.clientY; dy = 0; h.setPointerCapture(e.pointerId); panel.style.transition = "none"; });
  h.addEventListener("pointermove", (e) => {
    if (y0 === null) return;
    dy = e.clientY - y0;
    panel.style.transform = dy > 0 ? `translateY(${dy}px)` : ""; // follow the finger down; opening just snaps
  });
  const end = () => {
    if (y0 === null) return;
    y0 = null; panel.style.transition = panel.style.transform = "";
    setSheet(Math.abs(dy) < 8 ? !sheetOpen() : dy < 0);
  };
  h.addEventListener("pointerup", end);
  h.addEventListener("pointercancel", end);
}
map.on("dragstart", () => phone.matches && setSheet(false));
// MapLibre opens the compact attribution on load; on a phone it crowds the controls, so start it folded (the ⓘ opens it).
map.once("load", () => {
  const a = phone.matches && document.querySelector(".maplibregl-ctrl-attrib");
  if (a) { a.classList.remove("maplibregl-compact-show"); a.removeAttribute("open"); }
});
// Bottom map controls sit above whichever sheet (panel or popup) is showing.
const syncSheetHeight = () => {
  const el = document.body.classList.contains("popup-open") ? $("#popup") : sheetOpen() ? $("#panel") : null;
  document.documentElement.style.setProperty("--sheet-h", phone.matches && el ? `${el.offsetHeight}px` : "0px");
};
new ResizeObserver(syncSheetHeight).observe($("#panel"));
new ResizeObserver(syncSheetHeight).observe($("#popup"));
phone.addEventListener("change", () => { placeControls(); syncSheetHeight(); });
placeControls();

// ---------- search (phones) ----------
// Photon (OpenStreetMap geocoder, CORS-open, no key) limited to the city's box. Picking a result flies there and
// drops a pin; clearing the box removes it.
{
  const input = $("#searchInput"), list = $("#searchResults");
  let timer = 0, seq = 0, results = [], pin = null;
  const close = () => { list.hidden = true; list.innerHTML = ""; };
  const label = (f) => {
    const p = f.properties, place = [p.district || p.locality, p.city].filter((x, i, a) => x && a.indexOf(x) === i).join(", ");
    return { name: p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || place, place: p.name ? place : "" };
  };
  function go(f) {
    const p = f.properties, [lng, lat] = f.geometry.coordinates;
    input.value = label(f).name; input.blur(); close(); hidePopup(); setSheet(false);
    (pin ||= new maplibregl.Marker({ color: "#3ea8ff" })).setLngLat([lng, lat]).addTo(map);
    if (p.extent) map.fitBounds([[p.extent[0], p.extent[3]], [p.extent[2], p.extent[1]]], { padding: 60, maxZoom: 17.5 });
    else map.flyTo({ center: [lng, lat], zoom: 17 });
  }
  async function lookup(q) {
    const my = ++seq, c = map.getCenter();
    try {
      const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=10&lang=en&bbox=${CITY_BBOX.join(",")}&lat=${c.lat}&lon=${c.lng}`);
      if (my !== seq) return;
      // A long street comes back once per OSM segment; keep the first (nearest) of each name + neighborhood.
      const seen = new Set();
      results = ((await r.json()).features || []).filter((f) => { const l = label(f), k = `${l.name}|${l.place}`; return !seen.has(k) && seen.add(k); });
    } catch { if (my === seq) results = []; }
    if (my !== seq || !input.value.trim()) return;
    list.innerHTML = results.length
      ? results.map((f, i) => { const l = label(f); return `<li role="option" data-i="${i}">${esc(l.name)}${l.place ? `<small>${esc(l.place)}</small>` : ""}</li>`; }).join("")
      : `<li class="empty">No matches in Boston</li>`;
    list.hidden = false;
  }
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { seq++; close(); if (!q && pin) { pin.remove(); pin = null; } return; }
    timer = setTimeout(() => lookup(q), 250);
  });
  input.addEventListener("focus", () => { setSheet(false); if (list.innerHTML) list.hidden = false; });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(); input.blur(); } });
  $("#search").addEventListener("submit", (e) => { e.preventDefault(); if (results[0]) go(results[0]); });
  list.addEventListener("click", (e) => { const li = e.target.closest("li[data-i]"); if (li) go(results[+li.dataset.i]); });
  map.on("movestart", () => !list.hidden && document.activeElement !== input && close());
  map.on("click", () => { close(); input.blur(); });
}
buildTimeControls();
syncTime();

// ---------- popup ----------
const pretty = (s) => String(s).replace(/_/g, " ");
const cap = (s) => { s = pretty(s); return s[0].toUpperCase() + s.slice(1); };
const fmtStay = (min) => (min % 60 ? (min < 60 ? `${min} min` : `${(min / 60).toFixed(1).replace(/\.0$/, "")} hr`) : `${min / 60} hr`);
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// Normalize a clicked feature from either mode into zone props.
function zoneFromFeature(feature) {
  if (mode === "tiles") {
    const p = feature.properties;
    const pids = rulesets[p.rs] || "";
    return { curb_zone_id: feature.id, curb_policy_ids: pids ? pids.split(",") : [] };
  }
  return zones.get(feature.id)?.properties || feature.properties;
}

// "No parking except resident_permit" → "Resident permit only". Returns HTML-safe pieces.
function ruleBits(pol) {
  const rule = ruleOf(pol);
  const only = /^no /i.test(rule.activity || "") && rule.user_classes_except?.length;
  const bits = [isStreetCleaning(pol) ? "Street cleaning · tow zone" : esc(only ? `${cap(rule.user_classes_except.join(" or "))} only` : cap(rule.activity || "Rule"))];
  const why = !only && /^no /i.test(rule.activity || "") && reasonOf(pol);
  if (why) bits.push(why);
  if (rule.max_stay) bits.push(`${fmtStay(rule.max_stay)} max`);
  const rate = fmtRate(rule); if (rate) bits.push(rate);
  if (rule.user_classes?.length) bits.push(esc(rule.user_classes.map(pretty).join(", ")));
  return bits;
}
const spansText = (pol) => (pol.time_spans || []).map(fmtSpan).join("; ") || "Every day, all day";

function showPopup(feature, lngLat) {
  const p = zoneFromFeature(feature);
  const t = startTime(), day = dayKey(t), minute = minuteOf(t);
  const hol = holidayName(), meterFree = day === "sun" || !!hol;
  const v = verdict(p, policies, day, minute, { meterFree, date: t });
  const category = v.category, cat = CATEGORIES[category], blurb = cat.blurb;
  // The selected day in order: one row per stretch of time, the one at the chosen time marked.
  const blocks = daySchedule(p, policies, day, t, { meterFree });
  const clock = (m) => fmtTime(`${Math.floor(m / 60)}:${m % 60}`);
  const blockLabel = ({ v: b }) => {
    if (b.category === "accessible_permit") return "Accessible space · resident permit also posted";
    if (!b.policy) return "No posted rule";
    if (b.meterFree) return `Free${hol ? ` (${esc(hol)})` : day === "sun" ? " (Sunday)" : ""}`;
    const bits = ruleBits(b.policy);
    if (b.category === "free" && bits[0] === "Parking") bits[0] = "Free parking";
    return bits.join(" · ");
  };
  const hasRules = (p.curb_policy_ids || []).some((id) => policies[id] && isRealPolicy(policies[id]));
  const rows = !hasRules ? "" : blocks.map((b) => {
    const on = minute >= b.from && minute < b.to;
    return `<li class="${on ? "on" : ""}${b.v.policy ? "" : " none"}" style="--c:${catColor(b.v.category, theme)}"><span>${b.from === 0 && b.to === 1440 ? "All day" : `${clock(b.from)} – ${clock(b.to)}`}</span><b>${blockLabel(b)}</b>${on ? `<em>${live ? "Now" : fmtClock(t)}</em>` : ""}</li>`;
  }).join("");
  // Rules not in force at any time this day (other weekdays, other months, snow emergencies): one tag each.
  const all = (p.curb_policy_ids || []).map((id) => policies[id]).filter((pol) => pol && isRealPolicy(pol));
  const today = (pol) => Array.from({ length: 48 }, (_, k) => k * 30).some((m) => policyActive(pol, day, m, t));
  // Tags lead with the rule ("Street cleaning"), then when ("1st & 3rd Wed · 12–4 PM · Mar–Dec").
  const what = (pol) => (isStreetCleaning(pol) ? "Street cleaning" : ruleBits(pol).join(" · "));
  const tags = collapsePolicies(all.filter((pol) => !today(pol) && !overriddenBy(pol, all))).map(({ policy: pol }) => {
    const when = (pol.time_spans?.length ? pol.time_spans : [null]).map(fmtSpanShort).join("; ");
    return `<li><b>${what(pol)}</b> ${esc(when)}</li>`;
  }).join("");
  // Signs the build found cover only part of this curb ("~id": a hydrant on a metered block): listed, not graded.
  const partial = collapsePolicies((p.curb_policy_ids || []).filter((id) => String(id).startsWith("~")).map((id) => policies[id.slice(1)]).filter((pol) => pol && isRealPolicy(pol)))
    .map(({ policy: pol }) => `<li class="part"><b>${what(pol)}</b> on part of this curb</li>`).join("");
  const title = [p.street_name, p.street_side ? `${p.street_side} side` : null].filter(Boolean).join(" · ");
  $("#popup").innerHTML = `
    <button class="x" aria-label="close">×</button>
    <div class="verdict" style="--c:${catColor(category, theme)}"><span>${cat.label}</span>${blurb ? `<small>${esc(blurb)}</small>` : ""}</div>
    ${title ? `<h3>${esc(title)}</h3>` : ""}
    <div class="meta">${p.user_zone_id ? `Zone #${esc(p.user_zone_id)} · ` : ""}${fmtDay(t)} · ${fmtClock(t)}${demoMode ? " · <b>demo data</b>" : ""}</div>
    ${rows ? `<ul class="agenda">${rows}</ul>` : `<p class="empty">No sign data recorded for this curb.</p>`}
    ${tags || partial ? `<ul class="tags">${partial}${tags}</ul>` : ""}`;
  $("#popup").classList.remove("hidden");
  document.body.classList.add("popup-open");
  syncSheetHeight();
  $("#popup .x").onclick = hidePopup;
  select(feature.id);
  const pt = map.project(lngLat);
  const el = $("#popup");
  const W = el.offsetWidth || 300, H = el.offsetHeight || 200;
  if (phone.matches) {
    // The popup is a bottom sheet here; slide the curb up into the open map above it if the sheet would cover it.
    const room = innerHeight - H;
    if (pt.y > room - 24) { keepPopup = true; map.panBy([0, pt.y - room / 2], { duration: 300 }); map.once("moveend", () => (keepPopup = false)); }
    return;
  }
  el.style.left = Math.min(Math.max(12, pt.x - W / 2), innerWidth - W - 12) + "px";
  el.style.top = Math.max(12, pt.y - H - 18) + "px";
}
let keepPopup = false;
function hidePopup() {
  $("#popup").classList.add("hidden"); select(null);
  document.body.classList.remove("popup-open");
  syncSheetHeight();
}
map.on("move", () => keepPopup || hidePopup());
