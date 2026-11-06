import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { CATEGORIES, verdict, daySchedule, policyActive, fmtSpanShort, fmtTime, fmtRate, fmtSpan, dayKey, isRealPolicy, isStreetCleaning, ruleOf, collapsePolicies, overriddenBy, reasonOf, catColor, shade, cityHoliday, stayWindow, evaluateStay } from "./rules.js";
import { DEMO_ZONES, DEMO_POLICIES } from "./demo.js";
import { createEditor } from "./editor.js";
import { createModeration } from "./moderation.js";
import { buildStyle, curbPaint, CURB_LAYERS, CURB_FADE_ZOOM, CURB_ZOOM, NO_DATA_ZOOM, PICK_ZOOM } from "./basemap.js";
import { CODES, CATEGORY_OF, SLOT_MIN } from "./schedule.js";
import { inject as injectAnalytics } from "@vercel/analytics";

injectAnalytics();

const $ = (s) => document.querySelector(s);
// Data-loading progress and problems go to the console (the panel has no status line).
const status = (msg, kind = "") => (kind === "warn" ? console.warn : console.info)(`[curbs] ${msg}`);
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

// ?at=<lng>,<lat> opens on one spot at street zoom (the review page links curbs this way).
const AT = new URLSearchParams(location.search).get("at")?.split(",").map(Number);
const atSpot = AT?.length === 2 && AT.every(Number.isFinite) ? AT : null;
const map = new maplibregl.Map({
  container: "map",
  center: atSpot || [-71.07, 42.35], // central Boston, at a zoom where curbs are drawn (they start at CURB_FADE_ZOOM)
  zoom: atSpot ? 18.5 : 12.6,
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

// After any setStyle (theme switch) feature-state is gone: recolor.
map.on("style.load", repaint);

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
  // current zoom or legend hides (anything below CURB_ZOOM, no-data below NO_DATA_ZOOM), and none below PICK_ZOOM.
  map.on("mousemove", (e) => {
    const f = pickCurb(e.point);
    map.getCanvas().style.cursor = f ? "pointer" : "";
    const id = f ? f.id : null;
    if (hoverId !== null && hoverId !== id) map.setFeatureState({ ...curbSource(), id: hoverId }, { hover: false });
    hoverId = id;
    if (id !== null) map.setFeatureState({ ...curbSource(), id }, { hover: true });
  });
  map.on("click", (e) => { if (editor.editing) return; const f = pickCurb(e.point); if (phone.matches) setSheet(false); f ? showPopup(f, e.lngLat) : hidePopup(); }); // editing: map taps don't lose the draft
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
  if (map.getZoom() < PICK_ZOOM) return null; // curbs are drawn from CURB_ZOOM, but only pickable from here
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

// ---------- search ----------
// Like Google Maps: five suggestions from the first letter, updated on every keystroke. Streets come from the build's
// list of streets with curbs (data/streets.json, loaded on first focus), so they're instant; from the third letter,
// places (stations, parks, buildings) from Photon (OpenStreetMap geocoder, CORS-open, no key, limited to the city's
// box) fill in when they arrive. Picking a result flies there and drops a pin; clearing the box removes it.
{
  const form = $("#search"), input = $("#searchInput"), list = $("#searchResults"), LIMIT = 5;
  let seq = 0, timer = 0, shown = [], places = [], active = -1, pin = null, streets = [], loading = null;
  const loadStreets = () => (loading ||= fetch("/data/streets.json").then((r) => (r.ok ? r.json() : [])).catch(() => []).then((d) => (streets = d)));
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const close = () => { list.hidden = true; form.classList.remove("open"); active = -1; };
  // Where the typed words match a name: each one the start of a word of it, in order ("mass ave" → Massachusetts
  // Avenue). [[from, to], …] or null.
  const matchAt = (name, q) => {
    const n = norm(name), words = [...n.matchAll(/[a-z0-9']+/g)], out = [];
    let w = 0;
    for (const t of q.split(/\s+/).filter(Boolean)) {
      while (w < words.length && !words[w][0].startsWith(t)) w++;
      if (w === words.length) return null;
      out.push([words[w].index, words[w].index + t.length]);
      w++;
    }
    return out.length ? out : null;
  };
  const bold = (name, at) => {
    let html = "", k = 0;
    for (const [a, b] of at || []) { html += esc(name.slice(k, a)) + `<b>${esc(name.slice(a, b))}</b>`; k = b; }
    return html + esc(name.slice(k));
  };
  function streetMatches(q) {
    const c = map.getCenter(), out = [];
    for (const [name, place, w, s, e, n, anchors] of streets) {
      const at = matchAt(name, q);
      if (!at) continue;
      const dist = Math.hypot((Math.max(w, Math.min(e, c.lng)) - c.lng) * 0.74, Math.max(s, Math.min(n, c.lat)) - c.lat);
      out.push({ name, place, at, bbox: [w, s, e, n], anchors, rank: (at[0][0] ? 1 : 0) + dist * 20 });
    }
    return out.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length);
  }
  const placeOf = (f) => {
    const p = f.properties, where = [p.district || p.locality, p.city].filter((x, i, a) => x && a.indexOf(x) === i).join(", ");
    const name = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || where;
    const [lng, lat] = f.geometry.coordinates;
    return { name, place: p.name ? where : "", at: null, lngLat: [lng, lat], bbox: p.extent ? [p.extent[0], p.extent[3], p.extent[2], p.extent[1]] : null };
  };
  // Streets first, places after; when both have matches, at most three streets so places get a look in.
  function render(q) {
    const st = streetMatches(q), pl = places.filter((p) => !st.some((x) => norm(x.name) === norm(p.name)));
    const nst = Math.min(st.length, Math.max(LIMIT - pl.length, pl.length ? 3 : LIMIT));
    shown = [...st.slice(0, nst), ...pl].slice(0, LIMIT);
    active = -1;
    if (!shown.length) { list.innerHTML = q.length >= 3 ? `<li class="empty">No matches in Boston</li>` : ""; }
    else list.innerHTML = shown.map((r, i) => {
      const name = bold(r.name, r.at || matchAt(r.name, q));
      return `<li role="option" data-i="${i}"><svg class="pin" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/></svg><span class="txt"><span class="nm">${name}</span>${r.place ? ` <small>${esc(r.place)}</small>` : ""}</span></li>`;
    }).join("");
    const open = !!list.innerHTML;
    list.hidden = !open; form.classList.toggle("open", open);
  }
  function setActive(i) {
    active = (i + shown.length) % shown.length;
    list.querySelectorAll("li[data-i]").forEach((li) => li.setAttribute("aria-selected", String(+li.dataset.i === active)));
  }
  async function update() {
    const q = norm(input.value.trim()), my = ++seq;
    clearTimeout(timer);
    if (!q) { places = []; close(); if (pin) { pin.remove(); pin = null; } return; }
    await loadStreets();
    if (my !== seq) return;
    places = places.filter((p) => matchAt(p.name, q)); // keep what still fits while the next answer is on its way
    render(q);
    if (q.length < 3) return;
    timer = setTimeout(async () => {
      try {
        const c = map.getCenter();
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(input.value.trim())}&limit=8&lang=en&bbox=${CITY_BBOX.join(",")}&lat=${c.lat}&lon=${c.lng}`);
        const found = ((await r.json()).features || []).filter((f) => f.properties.osm_key !== "highway" && (f.properties.city || "Boston") === "Boston").map(placeOf); // the map is Boston's curbs
        if (my !== seq) return;
        const seen = new Set();
        places = found.filter((p) => { const k = `${p.name}|${p.place}`; return !seen.has(k) && seen.add(k); });
        render(q);
      } catch { /* streets alone, then */ }
    }, 120);
  }
  function go(r) {
    input.value = r.name; input.blur(); close(); hidePopup(); setSheet(false);
    // On desktop, frame it in the map right of the panel.
    const left = phone.matches ? 0 : $("#panel").offsetWidth + 16, padding = { top: 80, bottom: 60, left: left + 60, right: 60 };
    let target = r.lngLat;
    if (r.bbox) {
      const cam = map.cameraForBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding, maxZoom: 17.5 });
      if (cam && cam.zoom >= 15) { map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding, maxZoom: 17.5 }); target ||= cam.center.toArray?.() || [cam.center.lng, cam.center.lat]; }
      else if (r.anchors?.length) {
        // A long street: go to its stretch nearest what's on screen, close enough to pick a curb.
        const c = map.getCenter();
        let best = null;
        for (let k = 0; k < r.anchors.length; k += 2) { const d = Math.hypot((r.anchors[k] - c.lng) * 0.74, r.anchors[k + 1] - c.lat); if (!best || d < best.d) best = { d, p: [r.anchors[k], r.anchors[k + 1]] }; }
        target = best.p;
        map.flyTo({ center: target, zoom: 16.5, offset: [left / 2, 0] });
      } else { target = cam ? [cam.center.lng, cam.center.lat] : [(r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2]; map.flyTo({ center: target, zoom: 15, offset: [left / 2, 0] }); }
    } else map.flyTo({ center: target, zoom: 17, offset: [left / 2, 0] });
    (pin ||= new maplibregl.Marker({ color: "#3ea8ff" })).setLngLat(target).addTo(map);
  }
  input.addEventListener("input", update);
  input.addEventListener("focus", () => { setSheet(false); loadStreets(); if (input.value.trim()) update(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); input.blur(); }
    else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && shown.length && !list.hidden) { e.preventDefault(); setActive(active + (e.key === "ArrowDown" ? 1 : -1)); }
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); const r = shown[active >= 0 ? active : 0]; if (r) go(r); });
  list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the box while clicking a result
  list.addEventListener("click", (e) => { const li = e.target.closest("li[data-i]"); if (li) go(shown[+li.dataset.i]); });
  input.addEventListener("blur", () => setTimeout(close, 0));
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

// One day of a curb as agenda rows: one per stretch of time, the one holding `minute` marked (null: none marked).
// Used by the popup, the editor's preview and pending corrections. `generic`: a weekday in general (opts.day), not the
// date `t` (no holidays, every-other-week rules shown as in force).
function scheduleRows(zone, pols, t, minute = null, { day: weekday, generic = false } = {}) {
  const day = weekday || dayKey(t), hol = generic ? null : cityHoliday(t), meterFree = day === "sun" || !!hol;
  const clock = (m) => fmtTime(`${Math.floor(m / 60)}:${m % 60}`);
  const blockLabel = ({ v: b }) => {
    if (b.category === "accessible_permit") return "Accessible space · resident permit also posted";
    if (!b.policy) return "No posted rule";
    if (b.meterFree) return `Free parking${hol ? ` (${esc(hol)})` : day === "sun" ? " (Sunday)" : ""}`;
    const bits = ruleBits(b.policy);
    if (b.category === "free" && bits[0] === "Parking") bits[0] = "Free parking";
    return bits.join(" · ");
  };
  return daySchedule(zone, pols, day, generic ? undefined : t, { meterFree }).map((b) => {
    const on = minute != null && minute >= b.from && minute < b.to;
    return `<li class="${on ? "on" : ""}${b.v.policy ? "" : " none"}" style="--c:${catColor(b.v.category, theme)}"><span>${b.from === 0 && b.to === 1440 ? "All day" : `${clock(b.from)} – ${clock(b.to)}`}</span><b>${blockLabel(b)}</b>${on ? `<em>${live ? "Now" : fmtClock(t)}</em>` : ""}</li>`;
  }).join("");
}

function showPopup(feature, lngLat) {
  const p = zoneFromFeature(feature);
  const t = startTime(), day = dayKey(t), minute = minuteOf(t);
  const hol = holidayName(), meterFree = day === "sun" || !!hol;
  const v = verdict(p, policies, day, minute, { meterFree, date: t });
  const category = v.category, cat = CATEGORIES[category], blurb = cat.blurb;
  // The selected day in order: one row per stretch of time, the one at the chosen time marked.
  const hasRules = (p.curb_policy_ids || []).some((id) => policies[id] && isRealPolicy(policies[id]));
  const rows = hasRules ? scheduleRows(p, policies, t, minute) : "";
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
    ${tags || partial ? `<ul class="tags">${partial}${tags}</ul>` : ""}
    ${goLinks(curbSpot(feature, lngLat))}
    ${mode === "tiles" ? `<div class="curb-actions"></div>` : ""}`;
  if (mode === "tiles") editor.actions($("#popup .curb-actions"), feature, p, () => showPopup(feature, lngLat), lngLat);
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
// The point of the curb nearest the tap (on the drawn line: the road's centerline for a snapped curb) and, for a
// snapped curb, the heading that looks from the road at it (+1 = right of the line's direction).
function curbSpot(feature, lngLat) {
  const g = feature.geometry, lines = g?.type === "MultiLineString" ? g.coordinates : g?.type === "LineString" ? [g.coordinates] : [];
  const q = map.project(lngLat);
  let best = null;
  for (const l of lines) for (let k = 1; k < l.length; k++) {
    const a = map.project(l[k - 1]), b = map.project(l[k]), dx = b.x - a.x, dy = b.y - a.y;
    const u = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(q.x - a.x - u * dx, q.y - a.y - u * dy);
    if (!best || d < best.d) best = { d, a: l[k - 1], b: l[k], u };
  }
  if (!best) return { lng: lngLat.lng, lat: lngLat.lat, heading: null };
  const { a, b, u } = best, lng = a[0] + (b[0] - a[0]) * u, lat = a[1] + (b[1] - a[1]) * u;
  const bearing = (Math.atan2((b[0] - a[0]) * Math.cos((lat * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI;
  const side = feature.properties?.side || 0;
  return { lng, lat, heading: side ? Math.round((bearing + 90 * side + 360) % 360) : null };
}
// Look at the curb in Street View, or get driving directions to it.
function goLinks({ lng, lat, heading }) {
  const at = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const link = (href, label, title) => `<a class="go" href="${href}" target="_blank" rel="noopener" title="${title}">${label}</a>`;
  return `<div class="go-row">
    ${link(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${at}${heading != null ? `&heading=${heading}` : ""}`, "Street View", "Look at this curb in Google Street View")}
    ${link(`https://www.google.com/maps/dir/?api=1&destination=${at}&travelmode=driving`, "Google Maps", "Driving directions to this curb in Google Maps")}
    ${link(`https://maps.apple.com/?daddr=${at}&dirflg=d`, "Apple Maps", "Driving directions to this curb in Apple Maps")}
  </div>`;
}
let keepPopup = false;
function hidePopup() {
  editor.close();
  $("#popup").classList.add("hidden"); select(null);
  document.body.classList.remove("popup-open");
  syncSheetHeight();
}
map.on("move", () => keepPopup || editor.editing || hidePopup());

// ---------- community submissions (src/editor.js) ----------
const editor = createEditor({
  $, esc, map, store, scheduleRows, ruleBits, fmtDay,
  policies: () => policies, rulesets: () => rulesets, manifest: () => manifest, startTime,
  close: hidePopup, resize: () => syncSheetHeight(),
});
// Moderators: the corrections stream, opened from a map button (src/moderation.js).
createModeration({
  $, esc, map, store, policies: () => policies, manifest: () => manifest, curbInfo: (id) => editor.curbInfo(id), hidePopup,
});
