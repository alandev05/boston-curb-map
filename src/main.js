import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { CATEGORIES, verdict, fmtRate, fmtSpan, dayKey, policyActive } from "./rules.js";
import { DEMO_ZONES, DEMO_POLICIES } from "./demo.js";

const $ = (s) => document.querySelector(s);
const status = (msg, kind = "") => { const el = $("#status"); el.textContent = msg; el.className = `status ${kind}`; };

// ---------- state ----------
const zones = new Map();          // curb_zone_id -> Feature
let policies = {};                 // curb_policy_id -> policy
let demoMode = false;
const hidden = new Set();          // hidden categories
let day = dayKey(), hour = new Date().getHours();
const fetchedTiles = new Set();

// ---------- map ----------
const CARTO = (layer) => [0, 1, 2, 3].map((i) => `https://${"abcd"[i]}.basemaps.cartocdn.com/rastertiles/${layer}/{z}/{x}/{y}@2x.png`);
const map = new maplibregl.Map({
  container: "map",
  center: [-71.0589, 42.3601],
  zoom: 14.2,
  minZoom: 10,
  maxZoom: 20,
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      base: { type: "raster", tiles: CARTO("voyager_nolabels"), tileSize: 256, attribution: "© OpenStreetMap, © CARTO" },
      labels: { type: "raster", tiles: CARTO("voyager_only_labels"), tileSize: 256 },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#fdf6e3" } },
      // Cartoon treatment: crank saturation + contrast on the basemap, mute brightness a touch.
      { id: "base", type: "raster", source: "base", paint: { "raster-saturation": 0.65, "raster-contrast": 0.35, "raster-brightness-max": 0.92, "raster-hue-rotate": 8 } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), "bottom-right");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

const colorExpr = ["match", ["get", "cat"], ...Object.entries(CATEGORIES).flatMap(([k, v]) => [k, v.color]), "#c9c9c9"];

map.on("load", () => {
  map.addSource("zones", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "curb_zone_id" });
  map.addSource("meters", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  map.addLayer({ id: "zone-fill", type: "fill", source: "zones", filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": colorExpr, "fill-opacity": 0.35 } });
  // Chunky dark outline = the cartoon ink line
  map.addLayer({ id: "zone-casing", type: "line", source: "zones", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#1b1b2f", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 16, 10, 19, 18], "line-opacity": 0.9 } });
  map.addLayer({ id: "zone-line", type: "line", source: "zones", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": colorExpr, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.6, 16, 6, 19, 12],
      "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 1, 0.95] } });
  // Highlight ring on hover
  map.addLayer({ id: "zone-hover", type: "line", source: "zones", layout: { "line-cap": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 6, 16, 16, 19, 26],
      "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.55, 0] } }, "zone-casing");

  map.addLayer({ id: "meters", type: "circle", source: "meters", layout: { visibility: "none" },
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2, 17, 7], "circle-color": "#4d9fff",
      "circle-stroke-color": "#1b1b2f", "circle-stroke-width": 2 } });

  map.addLayer({ id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.9 } });

  buildLegend();
  loadPolicies().then(() => refreshViewport());
  map.on("moveend", refreshViewport);

  let hoverId = null;
  map.on("mousemove", "zone-line", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const id = e.features[0].id;
    if (hoverId !== null && hoverId !== id) map.setFeatureState({ source: "zones", id: hoverId }, { hover: false });
    hoverId = id; map.setFeatureState({ source: "zones", id }, { hover: true });
  });
  map.on("mouseleave", "zone-line", () => {
    map.getCanvas().style.cursor = "";
    if (hoverId !== null) map.setFeatureState({ source: "zones", id: hoverId }, { hover: false });
    hoverId = null;
  });
  map.on("click", "zone-line", (e) => showPopup(e.features[0], e.lngLat));
  map.on("click", "zone-fill", (e) => showPopup(e.features[0], e.lngLat));
  map.on("click", (e) => { if (!map.queryRenderedFeatures(e.point, { layers: ["zone-line", "zone-fill"] }).length) hidePopup(); });
});

// ---------- data ----------
async function loadPolicies() {
  try {
    const r = await fetch("/api/policies");
    if (!r.ok) throw new Error(`policies ${r.status}`);
    policies = await r.json();
    if (!Object.keys(policies).length) throw new Error("policy list empty");
  } catch (e) {
    console.warn("policies unavailable, lazy-loading per zone", e);
    policies = {};
  }
}

function tileKey(b) { return b.map((n) => n.toFixed(2)).join(","); }

async function refreshViewport() {
  if (map.getZoom() < 12.5) { status("Zoom in to load curb zones (≥ z12.5)", "muted"); return; }
  const b = map.getBounds();
  // snap to 0.01° grid so repeated pans reuse cached tiles
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
    for (const ft of fc.features) {
      const id = ft.properties.curb_zone_id || ft.id;
      ft.id = id; ft.properties.curb_zone_id = id;
      zones.set(id, ft);
    }
    // Any policy ids we don't have yet → fetch in a batch
    const missing = new Set();
    for (const ft of fc.features) for (const pid of ft.properties.curb_policy_ids || []) if (!policies[pid]) missing.add(pid);
    if (missing.size) {
      const r2 = await fetch(`/api/policies?ids=${[...missing].join(",")}`);
      if (r2.ok) Object.assign(policies, await r2.json());
    }
    demoMode = false;
    status(`${zones.size.toLocaleString()} curb zones loaded · updated ${fc.meta?.last_updated ? new Date(fc.meta.last_updated).toLocaleDateString() : "—"}`, "ok");
  } catch (e) {
    console.error(e);
    if (!zones.size) {
      demoMode = true;
      policies = { ...DEMO_POLICIES, ...policies };
      for (const ft of DEMO_ZONES.features) { ft.id = ft.properties.curb_zone_id; zones.set(ft.id, ft); }
      status(`City API unreachable (${e.message}). Showing demo curbs in Back Bay.`, "warn");
      map.flyTo({ center: [-71.081, 42.351], zoom: 16 });
    } else status(`Couldn't load this area: ${e.message}`, "warn");
  }
  repaint();
}

function repaint() {
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
$("#showMeters").addEventListener("change", (e) => {
  map.setLayoutProperty("meters", "visibility", e.target.checked ? "visible" : "none");
  if (e.target.checked && !map.getSource("meters")._data?.features?.length) loadMeters();
});
$("#showLabels").addEventListener("change", (e) => map.setLayoutProperty("labels", "visibility", e.target.checked ? "visible" : "none"));
$("#panelToggle").addEventListener("click", () => $("#panel").classList.toggle("collapsed"));
syncTime();

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function showPopup(feature, lngLat) {
  const p = zones.get(feature.id)?.properties || feature.properties;
  const minute = hour * 60;
  const v = verdict(p, policies, day, minute);
  const cat = CATEGORIES[v.category];
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
  // park the popup near the click, inside the viewport
  const pt = map.project(lngLat);
  const el = $("#popup");
  const W = el.offsetWidth || 300, H = el.offsetHeight || 200;
  el.style.left = Math.min(Math.max(12, pt.x - W / 2), innerWidth - W - 12) + "px";
  el.style.top = Math.max(12, pt.y - H - 18) + "px";
}
function hidePopup() { $("#popup").classList.add("hidden"); }
map.on("move", hidePopup);
