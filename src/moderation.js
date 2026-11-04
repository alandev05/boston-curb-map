// Moderation, on the map itself: a button above "find my location" (it asks for the admin token the first time;
// /review opens it straight away) opens a side panel with the stream of community corrections. Picking one flies the map to its curb and
// highlights it (just the stretch, when the correction covers part of the curb); the card expands to current vs
// proposed rules by weekday, the photo and note, and accept / reject / revert / history. Everything goes through
// /api/review with the X-Admin-Token header.
import { CATEGORIES, daySchedule, fmtTime, fmtRate, ruleOf, isRealPolicy } from "./rules.js";
import { renderedLines, slice } from "./curbgeom.js";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], NAME = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13l2.5-8h11L20 13v6H4z"/><path d="M4 13h4.5l1 2h5l1-2H20"/></svg>`;
const TABS = ["pending", "accepted", "rejected", "superseded"];

export function createModeration(d) {
  const { $, esc, map, store } = d;
  const token = () => store.get("adminToken") || "";
  let panel = null, button = null, status = "pending", items = [], openId = null;

  async function api(path, body) {
    const r = await fetch(path, { method: body ? "POST" : "GET", headers: { "X-Admin-Token": token(), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const js = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(js.error || `${r.status}`), { status: r.status });
    return js;
  }

  // ---------- the map button ----------
  class ReviewControl {
    onAdd() {
      const el = document.createElement("div");
      el.className = "maplibregl-ctrl maplibregl-ctrl-group mod-ctrl";
      el.innerHTML = `<button type="button" aria-label="Review corrections" title="Review corrections">${ICON}<span class="mod-badge" hidden></span></button>`;
      el.querySelector("button").onclick = () => (panel && !panel.hidden ? close() : open());
      button = el;
      return el;
    }
    onRemove() { button?.remove(); button = null; }
  }
  // Added last, so it stacks above the other bottom-right controls (MapLibre inserts bottom controls on top).
  function mount() {
    if (button) return;
    map.addControl(new ReviewControl(), "bottom-right");
    refreshBadge();
  }
  async function refreshBadge() {
    if (!button || !token()) return;
    try {
      const { submissions } = await api("/api/review?status=pending");
      const b = button.querySelector(".mod-badge");
      b.textContent = submissions.length > 99 ? "99+" : String(submissions.length);
      b.hidden = !submissions.length;
    } catch { /* wrong or missing token: the panel says so when opened */ }
  }

  // ---------- the panel ----------
  function build() {
    panel = document.createElement("aside");
    panel.id = "modPanel"; panel.className = "mod-panel"; panel.hidden = true;
    panel.innerHTML = `
      <div class="mod-head"><b>Corrections</b><button type="button" class="x" data-act="close" aria-label="Close">×</button></div>
      <form class="mod-login" autocomplete="off">
        <input name="reviewer" placeholder="Your name" aria-label="Reviewer name">
        <input name="token" type="password" placeholder="Admin token" aria-label="Admin token">
        <button class="primary" type="submit">Load</button>
      </form>
      <div class="mod-who" hidden><span></span><button type="button" class="link" data-act="forget">Forget token</button></div>
      <nav class="mod-tabs" role="tablist">${TABS.map((t) => `<button type="button" data-tab="${t}" aria-selected="${t === status}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</nav>
      <p class="mod-msg"></p>
      <ul class="mod-list"></ul>`;
    document.body.appendChild(panel);
    panel.querySelector(".mod-login").onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      store.set("adminToken", f.token.value.trim()); store.set("reviewer", f.reviewer.value.trim());
      f.token.value = ""; syncLogin(); load(); refreshBadge();
    };
    panel.onclick = onClick;
  }
  function syncLogin() {
    const has = !!token();
    panel.querySelector(".mod-login").hidden = has;
    panel.querySelector(".mod-login").reviewer.value = store.get("reviewer") || "";
    panel.querySelector(".mod-who").hidden = !has;
    panel.querySelector(".mod-who span").textContent = has ? `Reviewing as ${store.get("reviewer") || "moderator"}` : "";
    panel.querySelector(".mod-tabs").hidden = !has;
  }
  function open() {
    if (!panel) build();
    d.hidePopup();
    panel.hidden = false; document.body.classList.add("reviewing");
    syncLogin();
    if (token()) load(); else msg("Enter your name and the admin token.");
  }
  function close() {
    if (!panel) return;
    panel.hidden = true; document.body.classList.remove("reviewing");
    highlight(null); openId = null;
  }
  const msg = (t) => { panel.querySelector(".mod-msg").textContent = t; };

  async function load() {
    msg("Loading…");
    try {
      const { submissions } = await api(`/api/review?status=${status}`);
      items = submissions;
      if (!items.some((s) => s.id === openId)) { openId = null; highlight(null); }
      render();
      msg(items.length ? "" : `Nothing ${status}.`);
    } catch (e) {
      items = []; render();
      if (e.status === 401 && token()) { store.set("adminToken", ""); syncLogin(); }
      msg(e.message === "wrong admin token" ? "That admin token doesn't match the one set on the server." : e.message === "admin token required" ? "Enter the admin token." : `Couldn't load: ${e.message}`);
    }
  }

  // A set of rules as one line per group of weekdays with the same day ("Mon–Fri 8 AM–6 PM Paid meter (2 hr) · …").
  function week(pols, ids) {
    const zone = { curb_policy_ids: ids }, clock = (m) => fmtTime(`${Math.floor(m / 60)}:${m % 60}`);
    const label = (v) => {
      if (!v.policy) return "no posted rule";
      if (v.meterFree) return "free (meter off)";
      const r = ruleOf(v.policy), extra = [r.max_stay ? (r.max_stay < 60 ? `${r.max_stay} min` : `${r.max_stay / 60} hr`) : null, fmtRate(r)].filter(Boolean);
      return `${CATEGORIES[v.category]?.label || v.category}${extra.length ? ` (${extra.join(", ")})` : ""}`;
    };
    const lines = DAYS.map((day) => daySchedule(zone, pols, day, undefined, { meterFree: day === "sun" })
      .map((b) => `${b.from === 0 && b.to === 1440 ? "all day" : `${clock(b.from)}–${clock(b.to)}`} ${label(b.v)}`).join(" · "));
    const groups = [];
    DAYS.forEach((day, i) => { const g = groups.at(-1); if (g && g.text === lines[i]) g.days.push(day); else groups.push({ days: [day], text: lines[i] }); });
    return groups.map((g) => `<li><b>${NAME[g.days[0]]}${g.days.length > 1 ? `–${NAME[g.days.at(-1)]}` : ""}</b> ${esc(g.text)}</li>`).join("");
  }
  const proposed = (rules) => { const pols = {}, ids = (rules || []).map((r, i) => { const id = `p${i}`; pols[id] = { ...r, curb_policy_id: id }; return id; }); return week(pols, ids); };
  const current = (basedOn) => {
    const pols = d.policies(), ids = String(basedOn || "").split(",").filter((id) => id && !id.startsWith("~") && isRealPolicy(pols[id]));
    return ids.length ? week(pols, ids) : `<li class="muted">No rules recorded (or from an older build)</li>`;
  };
  // One line for the collapsed card: what the correction says on its first weekday.
  const gist = (rules) => { const m = proposed(rules).match(/<li><b>(.*?)<\/b> (.*?)<\/li>/); return m ? `${m[1]}: ${m[2]}` : ""; };

  function cardHTML(s) {
    const when = new Date(s.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const stretch = s.stretch_from != null ? `${Math.round(s.stretch_from)}–${Math.round(s.stretch_to)} m of ${Math.round(s.curb_length || 0)} m` : "whole curb";
    const agree = s.confirmations ? `${s.confirmations + 1} agree` : "";
    const head = `<button type="button" class="mod-item-head" data-act="pick"><span class="mi-when">${esc(when)}</span><span class="mi-meta">${esc(stretch)}${agree ? ` · ${agree}` : ""}${s.photo_url ? " · 📷" : ""}</span><span class="mi-gist">${esc(gist(s.rules))}</span>${s.note ? `<span class="mi-note">“${esc(s.note)}”</span>` : ""}</button>`;
    if (s.id !== openId) return `<li class="mod-item" data-id="${s.id}">${head}</li>`;
    const stale = d.manifest() && s.data_version && s.data_version !== d.manifest().version ? `<p class="muted">Seen on an older build of the map.</p>` : "";
    const here = s.lat != null ? `<a href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=19/${s.lat}/${s.lng}" target="_blank" rel="noopener">Submitter's location</a>${s.accuracy_m ? ` (±${Math.round(s.accuracy_m)} m)` : ""}` : "";
    const actions = s.status === "pending" ? `<button class="primary" data-act="accept">Accept</button><button class="ghost" data-act="reject">Reject</button>` : s.status === "accepted" ? `<button class="ghost" data-act="revert">Revert</button>` : "";
    return `<li class="mod-item open" data-id="${s.id}">${head}
      <div class="mod-detail">
        ${s.curb_lng == null ? `<p class="muted">No map location was sent with this one.</p>` : ""}${stale}
        <h4>Current</h4><ul class="rv-week">${current(s.based_on)}</ul>
        <h4>Proposed</h4><ul class="rv-week">${proposed(s.rules)}</ul>
        ${s.photo_url ? `<a href="${s.photo_url}" target="_blank" rel="noopener"><img class="mod-photo" src="${s.photo_url}" alt="Submitted photo of the sign"></a>` : ""}
        <p class="muted mod-small">Curb ${esc(s.curb_zone_id.slice(0, 8))}…${here ? ` · ${here}` : ""}</p>
        ${s.status !== "pending" ? `<p class="muted mod-small">${esc(s.status)}${s.reviewer ? ` by ${esc(s.reviewer)}` : ""}${s.reviewed_at ? ` · ${new Date(s.reviewed_at).toLocaleString()}` : ""}${s.review_note ? ` — “${esc(s.review_note)}”` : ""}</p>` : ""}
        <div class="mod-actions">${actions ? `<input class="rv-note-in" placeholder="Note (optional)" maxlength="1000">${actions}` : ""}<button class="link" data-act="history">History</button></div>
        <ol class="mod-history" hidden></ol>
      </div></li>`;
  }
  function render() {
    panel.querySelector(".mod-list").innerHTML = items.map(cardHTML).join("");
    d.resize?.();
  }

  async function onClick(e) {
    const b = e.target.closest("[data-act], [data-tab]");
    if (!b) return;
    if (b.dataset.tab) {
      status = b.dataset.tab; openId = null; highlight(null);
      for (const t of panel.querySelectorAll(".mod-tabs button")) t.setAttribute("aria-selected", String(t === b));
      return load();
    }
    const li = b.closest(".mod-item"), sub = li && items.find((s) => s.id === li.dataset.id);
    switch (b.dataset.act) {
      case "close": return close();
      case "forget": store.set("adminToken", ""); items = []; render(); syncLogin(); highlight(null); return msg("Token forgotten on this device.");
      case "pick": openId = openId === sub.id ? null : sub.id; render(); if (openId) { li.scrollIntoView?.({ block: "nearest" }); show(sub); } else highlight(null); return;
      case "history": {
        const ol = li.querySelector(".mod-history");
        if (!ol.hidden) { ol.hidden = true; return; }
        try {
          const { events } = await api(`/api/review?curb=${sub.curb_zone_id}`);
          ol.innerHTML = events.map((ev) => `<li><span class="muted">${new Date(ev.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span> ${esc(ev.action)} · ${esc(ev.actor.replace(/^device:(.{8}).*/, "device $1…"))}${ev.detail?.note ? ` — “${esc(ev.detail.note)}”` : ""}</li>`).join("") || "<li>No events.</li>";
          ol.hidden = false;
        } catch (err) { msg(err.message); }
        return;
      }
      case "accept": case "reject": case "revert": {
        b.disabled = true;
        try {
          const r = await api("/api/review", { id: sub.id, decision: b.dataset.act, note: li.querySelector(".rv-note-in")?.value || "", reviewer: store.get("reviewer") || "moderator" });
          const i = items.indexOf(sub);
          items.splice(i, 1); highlight(null);
          openId = items[i]?.id ?? items[i - 1]?.id ?? null; // straight on to the next one
          render();
          if (openId) show(items.find((s) => s.id === openId));
          msg(`${b.dataset.act === "accept" ? "Accepted" : b.dataset.act === "reject" ? "Rejected" : "Reverted"}${r.rebuild ? " — rebuilding the map." : b.dataset.act !== "reject" ? " — reaches the map on the next deploy." : "."}`);
          refreshBadge();
        } catch (err) { b.disabled = false; msg(err.message); }
      }
    }
  }

  // ---------- fly to a correction's curb and highlight it ----------
  let showing = 0;
  async function show(sub) {
    const my = ++showing;
    highlight(null);
    if (!sub || sub.curb_lng == null) return;
    const center = [sub.curb_lng, sub.curb_lat];
    map.flyTo({ center, zoom: Math.max(map.getZoom(), 18), offset: panelOffset(), duration: 900 });
    await new Promise((r) => map.once("moveend", r));
    await new Promise((r) => (map.loaded() ? r() : map.once("idle", r)));
    if (my !== showing) return;
    // The curb's pieces near where it was tapped (a curb cut by earlier corrections is several features).
    const p = map.project(center), near = map.queryRenderedFeatures([[p.x - 60, p.y - 60], [p.x + 60, p.y + 60]], { layers: ["zone-line"] });
    const ids = [...new Set(near.map((f) => f.id))], infos = await Promise.all(ids.map((id) => d.curbInfo(id)));
    if (my !== showing) return;
    const pieces = ids.map((id, i) => ({ id, info: infos[i] })).filter((x) => x.info?.zone === sub.curb_zone_id);
    const lines = renderedLines(map, pieces.map((x) => x.id)), features = [];
    for (const { id, info } of pieces) {
      const drawn = lines.get(id);
      if (!drawn?.line.length) continue;
      const pf = info.from ?? 0, pt = info.to ?? info.len, a = sub.stretch_from ?? pf, b = sub.stretch_to ?? pt;
      const lo = Math.max(a, pf), hi = Math.min(b, pt);
      if (hi <= lo) continue;
      features.push({ type: "Feature", properties: { side: drawn.props.side ?? 0, rc: drawn.props.rc ?? "" }, geometry: { type: "LineString", coordinates: slice(drawn.line, (lo - pf) / (pt - pf || 1), (hi - pf) / (pt - pf || 1)) } });
    }
    highlight(features.length ? { type: "FeatureCollection", features } : { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: center } }] });
  }
  // Keep the curb clear of the panel: desktop panel on the right, phone sheet at the bottom.
  const panelOffset = () => (!panel || panel.hidden ? [0, 0] : innerWidth > 640 ? [-(panel.offsetWidth + 16) / 2, 0] : [0, -panel.offsetHeight / 2]);
  function highlight(data) {
    if (!data) {
      for (const id of ["mod-highlight", "mod-point"]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource("mod-highlight")) map.removeSource("mod-highlight");
      return;
    }
    if (map.getSource("mod-highlight")) { map.getSource("mod-highlight").setData(data); return; }
    const color = document.documentElement.dataset.theme === "light" ? "#15181f" : "#ffffff";
    map.addSource("mod-highlight", { type: "geojson", data });
    map.addLayer({ id: "mod-highlight", type: "line", source: "mod-highlight", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round" },
      paint: { "line-color": color, "line-opacity": 0.6, "line-width": ["interpolate", ["exponential", 2], ["zoom"], 14, 5, 18, 14, 20, 26], "line-offset": map.getPaintProperty("zone-line", "line-offset") } });
    map.addLayer({ id: "mod-point", type: "circle", source: "mod-highlight", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 12, "circle-color": color, "circle-opacity": 0.35, "circle-stroke-width": 2, "circle-stroke-color": color } });
  }

  // The button is always there; /review also opens the panel.
  const onReview = location.pathname.replace(/\/$/, "") === "/review";
  const start = () => { mount(); if (onReview) open(); };
  if (map.loaded()) start(); else map.once("load", start);
  return { open, close };
}
