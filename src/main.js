import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { CATEGORIES, verdict, fmtRate, fmtSpan, dayKey, isRealPolicy, isMetered, isStreetCleaning, ruleOf, collapsePolicies, overriddenBy, catColor, shade, cityHoliday, stayWindow, evaluateStay } from "./rules.js";
import { DEMO_ZONES, DEMO_POLICIES } from "./demo.js";
import { buildStyle, curbPaint, LABEL_LAYERS, METER_LAYERS, CURB_LAYERS, DETAIL_ZOOM, NO_DATA_ZOOM, OVERVIEW_ROADS, OVERVIEW_MIN_LEN } from "./basemap.js";
import { CODES, CATEGORY_OF, SLOT_MIN } from "./schedule.js";

const $ = (s) => document.querySelector(s);
const status = (msg, kind = "") => { const el = $("#status"); el.textContent = msg; el.className = `status ${kind}`; };
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// ---------- state ----------
let policies = {};                 // curb_policy_id -> policy
let rulesets = [];                 // tiles: rs -> "id,id,…" (every distinct set of rule ids a curb carries)
const selected = new Set();        // legend: empty = show every rule; otherwise only these categories
// Time: by default the map follows the clock ("live"). Picking a start in the time panel pins it; a stay length
// (minutes, 0 = just this moment) switches the map to grading each curb for the whole stay.
let live = true;
let pinned = null;                 // Date, when not live
let stayMin = 0;
const profile = { permit: store.get("permit") === "1", placard: store.get("placard") === "1" };
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
const CATS = Object.keys(CODES), FITS = ["o", "b", "x"];
let grades = { key: "", cat: [], fit: [] };
// Includes the data mode and rule-set count, so grades made before the data arrived are never reused.
const stayKey = () => `${mode}|${rulesets.length}|${Math.floor(startTime().getTime() / 60000)}|${stayMin}|${+profile.permit}|${+profile.placard}`;
const lookup = (table, values) => ["at", ["at", ["get", "rs"], ["literal", table]], ["literal", values]];
// Not graded yet (or api mode): the weekly-dominant category baked into the tile.
const domCat = ["match", ["coalesce", ["get", "dom"], "u"], ...Object.entries(CODES).flatMap(([k, c]) => [c, k]), "unknown"];
const catKey = () => (mode !== "tiles" ? ["coalesce", ["get", "cat"], "unknown"] : grades.cat.length ? lookup(grades.cat, CATS) : domCat);
const FIT_CODE = { ok: "o", better: "b", breaks: "x", no: "x" };
const fitKey = () => (mode !== "tiles" ? ["coalesce", ["get", "fit"], "o"] : grades.fit.length ? lookup(grades.fit, FITS) : "o");
// The expressions below refer to ["var","cat"] / ["var","fit"]; curbPaint binds them once per paint property.
const CAT = ["var", "cat"], FIT = ["var", "fit"];
const highlightExpr = ["any", ["boolean", ["feature-state", "hover"], false], ["boolean", ["feature-state", "selected"], false]];
function colorExprFor() {
  const key = CAT, fallback = catColor("unknown", theme);
  const pairs = (f) => Object.keys(CATEGORIES).flatMap((k) => [k, f(catColor(k, theme))]);
  return ["case", highlightExpr, ["match", key, ...pairs((c) => shade(c, theme)), shade(fallback, theme)], ["match", key, ...pairs((c) => c), fallback]];
}
function gateExprFor() {
  const sel = selected.size ? ["case", ["in", CAT, ["literal", [...selected]]], 1, 0] : 1;
  const fade = stayMin ? ["match", FIT, "x", 0.22, 1] : 1;
  return sel === 1 && fade === 1 ? 1 : ["*", sel, fade];
}
const paintOpts = () => ({
  colorExpr: colorExprFor(), dimExpr: ["==", CAT, "unknown"], gateExpr: gateExprFor(),
  betterExpr: stayMin ? ["==", FIT, "b"] : false, bind: ["cat", catKey(), "fit", fitKey()],
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
    const [pr, rr] = await Promise.all([fetch("/data/policies.json"), fetch("/data/rulesets.json")]);
    policies = pr.ok ? await pr.json() : {};
    rulesets = rr.ok ? await rr.json() : [];
    mode = "tiles";
    gradeAll();
  } catch { mode = "api"; }
}

await detectMode();

const map = new maplibregl.Map({
  container: "map",
  center: [-71.0589, 42.3601],
  zoom: 12.2,
  minZoom: 9,
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
  // current zoom or legend hides (no-data below NO_DATA_ZOOM, side streets below DETAIL_ZOOM).
  map.on("mousemove", (e) => {
    const f = pickCurb(e.point);
    map.getCanvas().style.cursor = f ? "pointer" : "";
    const id = f ? f.id : null;
    if (hoverId !== null && hoverId !== id) map.setFeatureState({ ...curbSource(), id: hoverId }, { hover: false });
    hoverId = id;
    if (id !== null) map.setFeatureState({ ...curbSource(), id }, { hover: true });
  });
  map.on("click", (e) => { const f = pickCurb(e.point); f ? showPopup(f, e.lngLat) : hidePopup(); });
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
  if (cat === "unknown" && z < NO_DATA_ZOOM) return false;
  if (z < DETAIL_ZOOM && !(OVERVIEW_ROADS.includes(f.properties.rc) && (f.properties.len ?? 999) >= OVERVIEW_MIN_LEN)) return false;
  if (selected.size && !selected.has(cat)) return false;
  return true;
}
function pickCurb(pt) {
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
// With no stay it grades the single moment. Only reruns when the time, stay or "I have" toggles change.
function gradeAll() {
  const key = stayKey();
  if (grades.key === key) return false;
  const steps = stayWindow(startTime(), stayMin || 1), grade = (pids) => evaluateStay({ curb_policy_ids: pids ? pids.split(",") : [] }, policies, steps, profile);
  if (mode === "tiles") {
    const catIx = Object.fromEntries(CATS.map((c, i) => [c, i])), unknown = catIx.unknown;
    const cat = new Array(rulesets.length), fit = new Array(rulesets.length);
    rulesets.forEach((pids, i) => { const r = grade(pids); cat[i] = catIx[r.worst] ?? unknown; fit[i] = FITS.indexOf(FIT_CODE[r.fit] || "o"); });
    grades = { key, cat, fit };
  } else {
    const byRules = new Map();
    for (const ft of zones.values()) {
      const pids = (ft.properties.curb_policy_ids || []).join(",");
      let r = byRules.get(pids); if (!r) byRules.set(pids, (r = grade(pids)));
      ft.properties.cat = r.worst; ft.properties.fit = FIT_CODE[r.fit] || "o";
    }
    grades = { key, cat: [], fit: [] };
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
const fmtClock = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const fmtDur = (m) => (m < 60 ? `${m} min` : `${+(m / 60).toFixed(1)} hr`);
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const STAYS = [30, 60, 120, 180, 240, 480];

function buildTimeControls() {
  const today = midnight(new Date());
  $("#dateSel").innerHTML = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today); d.setDate(d.getDate() + i);
    return `<option value="${i}">${i === 0 ? "Today" : i === 1 ? "Tomorrow" : fmtDay(d)}</option>`;
  }).join("");
  $("#timeSel").innerHTML = Array.from({ length: (24 * 60) / SLOT_MIN }, (_, i) => {
    const d = new Date(today.getTime() + i * SLOT_MIN * 60000);
    return `<option value="${i * SLOT_MIN}">${fmtClock(d)}</option>`;
  }).join("");
  $("#stayChips").innerHTML = STAYS.map((m) => `<button type="button" data-min="${m}" aria-pressed="false">${fmtDur(m).replace(" hr", "h").replace(" min", "m")}</button>`).join("") +
    `<button type="button" data-min="custom" aria-pressed="false">…</button>`;
}
function pinFromControls() {
  const d = midnight(new Date()); d.setDate(d.getDate() + +$("#dateSel").value);
  live = false;
  pinned = new Date(d.getTime() + +$("#timeSel").value * 60000);
  syncTime();
}
function setStay(m) { stayMin = m; syncTime(); }
function syncTime() {
  const t = startTime(), hol = holidayName(), day = dayKey(t);
  const isToday = midnight(t).getTime() === midnight(new Date()).getTime();
  $("#whenLabel").textContent = `${live ? "Now · " : ""}${isToday && !live ? "Today" : fmtDay(t).split(",")[0]} ${fmtClock(t)}${stayMin ? ` · stay ${fmtDur(stayMin)}` : ""}`;
  $("#dateNote").textContent = hol ? `${hol} — meters free` : day === "sun" ? "Meters free on Sundays" : "";
  // Panel mirrors the state: live shows today + the current half hour.
  const dayIdx = Math.round((midnight(t) - midnight(new Date())) / 86400000);
  $("#dateSel").value = String(Math.max(0, Math.min(6, dayIdx)));
  $("#timeSel").value = String(Math.floor(minuteOf(t) / SLOT_MIN) * SLOT_MIN);
  const custom = stayMin && !STAYS.includes(stayMin);
  for (const b of document.querySelectorAll("#stayChips button")) b.setAttribute("aria-pressed", b.dataset.min === "custom" ? String(!!custom || !$("#stayCustomWrap").hidden) : String(+b.dataset.min === stayMin));
  $("#nowBtn").hidden = live && !stayMin;
  $("#stayKey").hidden = !stayMin;
  repaint();
}
$("#whenBtn").addEventListener("click", () => {
  const open = $("#whenPanel").hidden;
  $("#whenPanel").hidden = !open;
  $("#whenBtn").setAttribute("aria-expanded", String(open));
});
$("#dateSel").addEventListener("change", pinFromControls);
$("#timeSel").addEventListener("change", pinFromControls);
$("#stayChips").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.min === "custom") {
    const wrap = $("#stayCustomWrap"); wrap.hidden = !wrap.hidden;
    if (!wrap.hidden) { $("#stayCustom").focus(); return; }
    return setStay(0);
  }
  $("#stayCustomWrap").hidden = true;
  const m = +b.dataset.min;
  setStay(stayMin === m ? 0 : m); // tap the selected chip again to go back to "just this moment"
});
$("#stayCustom").addEventListener("change", (e) => {
  const h = Math.max(0.5, Math.min(24, +e.target.value || 0));
  e.target.value = h;
  setStay(Math.ceil((h * 60) / SLOT_MIN) * SLOT_MIN);
});
$("#nowBtn").addEventListener("click", () => {
  live = true; pinned = null; $("#stayCustomWrap").hidden = true; $("#stayCustom").value = "";
  setStay(0);
});
for (const [id, k] of [["#hasPermit", "permit"], ["#hasPlacard", "placard"]]) {
  $(id).checked = profile[k];
  $(id).addEventListener("change", (e) => { profile[k] = e.target.checked; store.set(k, e.target.checked ? "1" : "0"); repaint(); });
}
// Live mode keeps up with the clock: relabel every minute, recolor when the half hour (or a stay's start) moves.
let lastTick = "";
setInterval(() => {
  if (!live) return;
  const t = new Date(), tick = stayMin ? String(Math.floor(t / 60000)) : `${dayKey(t)}${Math.floor(minuteOf(t) / SLOT_MIN)}`;
  if (tick !== lastTick) { lastTick = tick; syncTime(); } else $("#whenLabel").textContent = `Now · ${fmtDay(t).split(",")[0]} ${fmtClock(t)}${stayMin ? ` · stay ${fmtDur(stayMin)}` : ""}`;
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

// One line on how the stay goes, for the popup header.
function stayHeadline(r) {
  const label = (c) => CATEGORIES[c]?.label.toLowerCase() || c;
  if (r.fit === "ok") return "Works for your whole stay";
  if (r.fit === "better") return `Gets better — ${label(r.reason.cat)} from ${fmtClock(r.at)}`;
  if (r.fit === "breaks") return r.reason.kind === "limit" ? `Doesn't last — ${fmtStay(r.reason.max)} limit, move by ${fmtClock(r.at)}` : `Doesn't last — ${label(r.reason.cat)} from ${fmtClock(r.at)}`;
  return `Not for you at ${fmtClock(r.at)} — ${label(r.reason.cat)}`;
}

// "No parking except resident_permit" → "Resident permit only". Returns HTML-safe pieces.
function ruleBits(pol) {
  const rule = ruleOf(pol);
  const only = /^no /i.test(rule.activity || "") && rule.user_classes_except?.length;
  const bits = [isStreetCleaning(pol) ? "Street cleaning · tow zone" : esc(only ? `${cap(rule.user_classes_except.join(" or "))} only` : cap(rule.activity || "Rule"))];
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
  let category = v.category;
  let blurb = CATEGORIES[category].blurb, timeline = "";
  if (stayMin) {
    const r = evaluateStay(p, policies, stayWindow(t, stayMin), profile);
    category = r.worst;
    blurb = stayHeadline(r);
    if (r.timeline.length > 1 || r.fit !== "ok") timeline = `<ul class="timeline">${r.timeline.map((s) =>
      `<li style="--c:${catColor(s.cat, theme)}"><i></i><span>${fmtClock(s.from)}–${fmtClock(s.to)}</span>${esc(CATEGORIES[s.cat].label)}</li>`).join("")}</ul>`;
  }
  const cat = CATEGORIES[category];
  // Only real rules, highest precedence first (CDS: lower priority number wins). The one deciding the color now is marked "Now".
  const ids = (p.curb_policy_ids || []).filter((id) => !policies[id] || isRealPolicy(policies[id]));
  const all = ids.map((id) => policies[id]).filter(Boolean).sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000));
  // Rules a higher-precedence, always-in-force rule overrides never apply: listed once, muted, at the end.
  const over = all.map((pol) => ({ pol, by: overriddenBy(pol, all) })).filter((o) => o.by);
  const pols = all.filter((pol) => !over.some((o) => o.pol === pol));
  // The same rule listed again for a subset of its times collapses into the broader one.
  const winner = v.policy;
  const rows = collapsePolicies(pols).map(({ policy: pol, absorbed }) => {
    const wins = pol === winner || absorbed.includes(winner);
    const bits = ruleBits(pol);
    let spans = spansText(pol);
    if (isMetered(pol)) spans += " · free Sundays & City holidays";
    if (wins && v.meterFree) bits.unshift(`<span class="free">Free ${live ? "now" : "then"}${hol ? ` (${esc(hol)})` : day === "sun" ? " (Sunday)" : " (outside meter hours)"}</span>`);
    return `<li class="${wins ? "on" : "dim"}"><b>${bits.join(" · ")}</b><br><span>${esc(spans)}</span>${wins ? `<em>${live ? "Now" : fmtClock(t)}</em>` : ""}</li>`;
  }).join("") + (over.length ? `<li class="dim overridden"><b>Doesn't apply here</b><br><span>${over.map(({ pol }) =>
    `${ruleBits(pol).join(" · ")} (${esc(spansText(pol))})`).join("; ")} — ${esc(ruleBits(over[0].by).join(" · "))} takes precedence ${spansText(over[0].by) === "Every day, all day" ? "at all times" : "at all those times"}.</span></li>` : "");
  const title = [p.street_name, p.street_side ? `${p.street_side} side` : null].filter(Boolean).join(" · ") || "Curb zone";
  $("#popup").innerHTML = `
    <button class="x" aria-label="close">×</button>
    <div class="verdict" style="--c:${catColor(category, theme)}"><span>${cat.label}</span><small>${esc(blurb)}</small></div>
    <h3>${esc(title)}</h3>
    <div class="meta">${p.user_zone_id ? `Zone #${esc(p.user_zone_id)} · ` : ""}${fmtDay(t).split(",")[0]} ${fmtClock(t)}${stayMin ? ` · ${fmtDur(stayMin)} stay` : ""}${demoMode ? " · <b>demo data</b>" : ""}</div>
    ${timeline}
    <ul class="rules">${rows || "<li class='dim'>No sign data recorded for this curb.</li>"}</ul>`;
  $("#popup").classList.remove("hidden");
  $("#popup .x").onclick = hidePopup;
  select(feature.id);
  const pt = map.project(lngLat);
  const el = $("#popup");
  const W = el.offsetWidth || 300, H = el.offsetHeight || 200;
  el.style.left = Math.min(Math.max(12, pt.x - W / 2), innerWidth - W - 12) + "px";
  el.style.top = Math.max(12, pt.y - H - 18) + "px";
}
function hidePopup() { $("#popup").classList.add("hidden"); select(null); }
map.on("move", hidePopup);
