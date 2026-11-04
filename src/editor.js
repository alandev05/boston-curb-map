// Community submissions, inside the curb popup: pending corrections ("Matches what I see"), and the
// "Fix this curb" editor (rule cards prefilled from the curb's current rules, a stretch of the curb, a live preview of
// the day, an optional note / photo / location). Everything goes through the API (api/submit.js etc.); nothing is
// written to the map until a moderator accepts it and the data is rebuilt.
import maplibregl from "maplibre-gl";
import { RULE_TYPES, WEEK, LIMITS, newCard, cardToPolicy, cardsFor } from "./submission.js";
import { CATEGORIES, catColor, fmtTime, isRealPolicy, overriddenBy } from "./rules.js";
import { chain, slice } from "./curbgeom.js";
import { curbOffsetPx, mpp } from "./basemap.js";

const DAY_LETTER = { mon: "M", tue: "T", wed: "W", thu: "T", fri: "F", sat: "S", sun: "S" };
const DAY_NAME = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ORD = ["", "1st", "2nd", "3rd", "4th", "5th"];
const CHEV = `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const START_OPTS = Array.from({ length: 48 }, (_, k) => ({ v: hhmm(k * 30), l: fmtTime(hhmm(k * 30)) }));
const END_OPTS = Array.from({ length: 48 }, (_, k) => ({ v: hhmm((k + 1) * 30), l: fmtTime(hhmm((k + 1) * 30)) }));
const LIMIT_OPTS = [{ v: "", l: "No limit" }, ...LIMITS.map((m) => ({ v: String(m), l: m < 60 ? `${m} min` : `${m / 60} hr` }))];
const TYPE_OPTS = Object.entries(RULE_TYPES).map(([v, t]) => ({ v, l: t.label }));
const MONTH_OPTS = [{ v: "", l: "All year" }, ...MONTHS.map((l, i) => ({ v: String(i + 1), l }))];
const DRAW_LAYERS = ["zone-line"];

export function createEditor(d) {
  const theme = () => document.documentElement.dataset.theme || "dark";
  const typeColor = (type) => catColor(CATEGORIES[type] ? type : "unknown", theme());
  let state = null; // the open editor

  // ---------- plumbing ----------
  const deviceId = () => {
    let id = d.store.get("device");
    if (!id) { id = crypto.randomUUID(); d.store.set("device", id); }
    return id;
  };
  const shards = new Map();
  // Feature id → { zone (city curb id), rs, len (m, as the city drew it), from, to (when the curb is cut in pieces) }.
  async function curbInfo(id) {
    const m = d.manifest();
    if (!m?.curb_shard || id == null) return null;
    const k = Math.floor(id / m.curb_shard);
    if (!shards.has(k)) shards.set(k, fetch(`/data/curbs/${k}.json?v=${m.version}`).then((r) => (r.ok ? r.json() : [])).catch(() => []));
    const row = (await shards.get(k))[id % m.curb_shard];
    return row?.[0] ? { zone: row[0], rs: row[1], len: row[2], from: row[3] ?? null, to: row[4] ?? null } : null;
  }
  async function api(path, body) {
    const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    const js = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(js.error || `request failed (${r.status})`);
    return js;
  }
  const draftZone = (rules) => {
    const pols = {}, ids = rules.map((r, i) => { const id = `draft-${i}`; pols[id] = { ...r, curb_policy_id: id }; return id; });
    return { zone: { curb_policy_ids: ids }, pols };
  };

  // ---------- popup footer: confirm, pending corrections, open the editor ----------
  async function actions(el, feature, zone, back, lngLat) {
    el.innerHTML = `<div class="pending"></div><div class="act-row"><button type="button" class="act fix">✎ Fix this curb</button></div>`;
    const info = await curbInfo(feature.id);
    if (!el.isConnected) return;
    if (!info) { el.remove(); return; }
    el.querySelector(".fix").onclick = () => open(feature, zone, info, back, lngLat);
    // Pending corrections from others: preview for the selected day, and agree with one.
    try {
      const { pending } = await api(`/api/curb?zone=${info.zone}&device=${deviceId()}`);
      if (!el.isConnected || !pending?.length) return;
      const t = d.startTime();
      el.querySelector(".pending").innerHTML = pending.slice(0, 2).map((p) => {
        const { zone: z, pols } = draftZone(p.rules || []);
        return `<div class="pend" data-id="${p.id}"><div class="pend-head"><b>Correction pending review</b>${p.confirmations ? `<small>${p.confirmations + 1} agree</small>` : ""}</div>
          ${p.stretch ? `<small class="pend-stretch">${Math.round(p.stretch[0])}–${Math.round(p.stretch[1])} m along the curb</small>` : ""}
          <ul class="agenda">${d.scheduleRows(z, pols, t)}</ul>
          ${p.note ? `<p class="pend-note">“${d.esc(p.note)}”</p>` : ""}
          ${p.mine ? `<small class="muted">Yours — waiting for a moderator</small>` : `<button type="button" class="act agree">Matches what I see</button>`}</div>`;
      }).join("");
      for (const b of el.querySelectorAll(".agree")) b.onclick = async () => {
        b.disabled = true;
        try { await api("/api/confirm", { submission_id: b.closest(".pend").dataset.id, device_id: deviceId() }); b.textContent = "✓ Thanks"; }
        catch (e) { b.disabled = false; b.title = e.message; }
      };
      d.resize();
    } catch { /* no backend (local dev without keys): nothing pending to show */ }
  }

  // ---------- the editor ----------
  function open(feature, zone, info, back, lngLat) {
    const pols = d.policies(), all = (zone.curb_policy_ids || []).filter((id) => !String(id).startsWith("~")).map((id) => pols[id]).filter((p) => p && isRealPolicy(p));
    const cards = cardsFor(all.filter((p) => !overriddenBy(p, all)));
    const a = info.from ?? 0, b = info.to ?? info.len;
    state = {
      feature, info, back, point: lngLat ? [+lngLat.lng.toFixed(6), +lngLat.lat.toFixed(6)] : null, cards, range: [a, b], frac: [0, 1],
      note: "", photo: null, loc: false, day: dayOf(d.startTime()), done: false, busy: false, error: null,
    };
    const root = d.$("#popup");
    root.classList.add("editing"); document.body.classList.add("editing");
    root.onclick = onClick; root.oninput = onInput; root.onchange = onChange;
    startStretch();
    render();
  }
  const dayOf = (t) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][t.getDay()];
  function close() {
    if (!state) return;
    const root = d.$("#popup");
    root.classList.remove("editing"); document.body.classList.remove("editing");
    root.onclick = root.oninput = root.onchange = null;
    stopStretch();
    state = null;
  }
  const exit = () => { const back = state?.back; close(); back ? back() : d.close(); };

  const dd = (key, options, value) => {
    const cur = options.find((o) => o.v === String(value ?? "")) || options[0];
    return `<div class="dd" data-dd="${key}"><button type="button" class="dd-btn">${d.esc(cur.l)}${CHEV}</button><ul class="dd-list" hidden>${options.map((o) =>
      `<li><button type="button" data-v="${o.v}"${o.v === cur.v ? ' aria-selected="true"' : ""}>${d.esc(o.l)}</button></li>`).join("")}</ul></div>`;
  };
  function cardHTML(c, i) {
    const t = RULE_TYPES[c.type];
    return `<div class="rule-card" style="--c:${typeColor(c.type)}">
      <div class="rc-head">${dd(`type:${i}`, TYPE_OPTS, c.type)}<button type="button" class="rc-del" data-act="del" data-i="${i}" aria-label="Remove rule">✕</button></div>
      <div class="rc-days">${WEEK.map((day) => `<button type="button" data-act="day" data-i="${i}" data-d="${day}" aria-pressed="${c.days.includes(day)}" aria-label="${DAY_NAME[day]}">${DAY_LETTER[day]}</button>`).join("")}</div>
      <div class="rc-time"><label class="chk"><input type="checkbox" data-act="allday" data-i="${i}"${c.allDay ? " checked" : ""}> All day</label>${c.allDay ? "" : `${dd(`start:${i}`, START_OPTS, c.start)}<span>–</span>${dd(`end:${i}`, END_OPTS, c.end)}`}</div>
      ${t.limit ? `<div class="rc-row"><span>Time limit</span>${dd(`limit:${i}`, LIMIT_OPTS, c.limit ?? "")}</div>` : ""}
      ${t.rate ? `<div class="rc-row"><span>Rate</span><label class="rate">$<input type="number" data-act="rate" data-i="${i}" min="0" max="100" step="0.25" inputmode="decimal" value="${c.rate ?? ""}" placeholder="—"> / hr</label></div>` : ""}
      ${t.weeks ? `<div class="rc-row"><span>Weeks</span><div class="rc-weeks">${[1, 2, 3, 4, 5].map((w) => `<button type="button" data-act="week" data-i="${i}" data-w="${w}" aria-pressed="${c.weeks.includes(w)}">${ORD[w]}</button>`).join("")}</div>${c.weeks.length ? "" : `<small class="muted">every week</small>`}</div>` : ""}
      ${t.months ? `<div class="rc-row"><span>Months</span>${dd(`mfrom:${i}`, MONTH_OPTS, c.months?.[0] ?? "")}${c.months ? `<span>–</span>${dd(`mto:${i}`, MONTH_OPTS.slice(1), c.months[1])}` : ""}</div>` : ""}
    </div>`;
  }
  const problem = () => {
    if (!state.cards.length) return "Add at least one rule from the sign.";
    for (const [i, c] of state.cards.entries()) {
      if (!c.days.length) return `Rule ${i + 1}: pick at least one day.`;
      if (!c.allDay && c.start === c.end) return `Rule ${i + 1}: start and end are the same.`;
    }
    return null;
  };
  function render() {
    const root = d.$("#popup"), s = state, scroll = root.scrollTop;
    if (s.done) {
      root.innerHTML = `<div class="ed-head"><b>Thanks!</b><button type="button" class="x" data-act="cancel" aria-label="close">×</button></div>
        <p class="ed-done">Your correction is pending review. A moderator checks it before the map changes; others who see the same sign can confirm it meanwhile.</p>
        <div class="ed-foot"><button type="button" class="primary" data-act="cancel">Done</button></div>`;
      d.resize(); return;
    }
    const rules = s.cards.map((c, i) => cardToPolicy(c, `draft-${i}`)), { zone, pols } = draftZone(rules);
    const issue = problem();
    root.innerHTML = `
      <div class="ed-head"><b>Fix this curb</b><button type="button" class="x" data-act="cancel" aria-label="close">×</button></div>
      <p class="ed-hint">Make this match the sign. Each card is one rule; the preview shows what the map would say.</p>
      <div class="ed-stretch"><b>${stretchLabel()}</b>${isWhole() ? "" : `<button type="button" class="link" data-act="whole">Use the whole curb</button>`}</div>
      ${s.runs?.length ? `<p class="ed-hint">Drag the handles at the ends of the curb on the map to fix just part of it.</p>` : ""}
      <div class="ed-cards">${s.cards.map(cardHTML).join("") || `<p class="muted">No rules yet — add the ones posted on the sign.</p>`}</div>
      <button type="button" class="ed-add" data-act="add">+ Add rule</button>
      <div class="ed-sec ed-preview">
        <div class="ed-label">What the map will show</div>
        <div class="ed-days">${["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => `<button type="button" data-act="pday" data-d="${day}" aria-pressed="${s.day === day}">${DAY_NAME[day]}</button>`).join("")}</div>
        <ul class="agenda">${s.cards.length ? d.scheduleRows(zone, pols, d.startTime(), null, { day: s.day, generic: true }) : ""}</ul>
      </div>
      <div class="ed-sec">
        <label class="ed-label" for="edNote">Note <span class="muted">(optional)</span></label>
        <textarea id="edNote" data-act="note" rows="2" maxlength="1000" placeholder="e.g. “2 hr except Sunday”, “sign is faded”">${d.esc(s.note)}</textarea>
        <div class="ed-photo">${s.photo ? `<img src="${s.photo}" alt="Your photo of the sign"><button type="button" class="link" data-act="rmphoto">Remove photo</button>` : `<label class="ed-photo-btn">📷 Add a photo of the sign<input type="file" accept="image/*" capture="environment" data-act="photo" hidden></label>`}</div>
        <label class="chk"><input type="checkbox" data-act="loc"${s.loc ? " checked" : ""}> Include my location <span class="muted">(helps the reviewer)</span></label>
      </div>
      ${s.error ? `<p class="ed-error">${d.esc(s.error)}</p>` : ""}
      <div class="ed-foot"><button type="button" class="ghost" data-act="cancel">Cancel</button><button type="button" class="primary" data-act="submit"${issue || s.busy ? " disabled" : ""} title="${d.esc(issue || "")}">${s.busy ? "Sending…" : "Submit for review"}</button></div>`;
    root.scrollTop = scroll;
    d.resize();
  }
  const span = () => state.range[1] - state.range[0];
  const isWhole = () => state.frac[0] <= 0.001 && state.frac[1] >= 0.999;
  const stretchLabel = () => (isWhole() ? `Whole curb · ${Math.round(span())} m` : `${Math.round((state.frac[1] - state.frac[0]) * span())} m of ${Math.round(span())} m`);

  // ---------- events (delegated on the popup) ----------
  function onClick(e) {
    const s = state;
    if (!s) return;
    const ddBtn = e.target.closest(".dd-btn"), opt = e.target.closest(".dd-list button");
    if (ddBtn) { const list = ddBtn.nextElementSibling, open = list.hidden; closeLists(); list.hidden = !open; if (open) list.querySelector("[aria-selected]")?.scrollIntoView({ block: "nearest" }); return; }
    if (opt) { setDD(opt.closest(".dd").dataset.dd, opt.dataset.v); return; }
    closeLists();
    const el = e.target.closest("[data-act]");
    if (!el || el.matches("input, textarea")) return;
    const i = +el.dataset.i, c = s.cards[i];
    switch (el.dataset.act) {
      case "cancel": return exit();
      case "submit": return submit();
      case "add": s.cards.push(newCard(s.cards.length ? "no_parking" : "paid")); break;
      case "del": s.cards.splice(i, 1); break;
      case "day": c.days = c.days.includes(el.dataset.d) ? c.days.filter((x) => x !== el.dataset.d) : WEEK.filter((x) => x === el.dataset.d || c.days.includes(x)); break;
      case "week": { const w = +el.dataset.w; c.weeks = c.weeks.includes(w) ? c.weeks.filter((x) => x !== w) : [...c.weeks, w].sort(); break; }
      case "pday": s.day = el.dataset.d; break;
      case "whole": s.frac = [0, 1]; placeStretch(); break;
      case "rmphoto": s.photo = null; break;
      default: return;
    }
    s.error = null;
    render();
  }
  function setDD(key, v) {
    const [what, i] = key.split(":"), c = state.cards[+i];
    if (what === "type") { c.type = v; if (!RULE_TYPES[v].limit) c.limit = null; if (v === "paid" && c.limit == null) c.limit = 120; }
    else if (what === "start") c.start = v;
    else if (what === "end") c.end = v;
    else if (what === "limit") c.limit = v ? +v : null;
    else if (what === "mfrom") c.months = v ? [+v, c.months?.[1] ?? 12] : null;
    else if (what === "mto") c.months = [c.months?.[0] ?? 1, +v];
    render();
  }
  const closeLists = () => { for (const l of d.$("#popup").querySelectorAll(".dd-list")) l.hidden = true; };
  document.addEventListener("pointerdown", (e) => { if (state && !e.target.closest(".dd")) closeLists(); });
  function onInput(e) {
    const s = state, el = e.target;
    if (!s) return;
    if (el.dataset.act === "note") s.note = el.value;
    else if (el.dataset.act === "rate") s.cards[+el.dataset.i].rate = el.value === "" ? null : +el.value;
  }
  async function onChange(e) {
    const s = state, el = e.target;
    if (!s) return;
    if (el.dataset.act === "allday") { s.cards[+el.dataset.i].allDay = el.checked; render(); }
    else if (el.dataset.act === "loc") s.loc = el.checked;
    else if (el.dataset.act === "photo" && el.files?.[0]) {
      try { s.photo = await shrinkPhoto(el.files[0]); s.error = null; } catch { s.error = "Couldn't read that photo."; }
      render();
    }
  }

  // Re-encode on the phone: at most 1600 px, JPEG. Drawing to a canvas also drops the file's metadata (GPS etc.).
  async function shrinkPhoto(file) {
    const img = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement("canvas");
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.82);
  }

  async function submit() {
    const s = state;
    if (problem() || s.busy) return;
    s.busy = true; s.error = null; render();
    let location = null;
    if (s.loc && navigator.geolocation) {
      location = await new Promise((ok) => navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), () => ok(null), { enableHighAccuracy: true, timeout: 8000 }));
    }
    const whole = isWhole() && s.info.from == null, at = (f) => +(s.range[0] + f * span()).toFixed(1);
    try {
      await api("/api/submit", {
        kind: "correction", curb_zone_id: s.info.zone, curb_length: s.info.len, point: s.point,
        stretch: whole ? null : [at(s.frac[0]), at(s.frac[1])],
        rules: s.cards.map((c, i) => { const { curb_policy_id, ...p } = cardToPolicy(c, String(i)); return p; }),
        based_on: d.rulesets()[s.info.rs], data_version: d.manifest()?.version,
        note: s.note.trim() || null, photo: s.photo, location, device_id: deviceId(),
      });
      if (state !== s) return;
      s.done = true; s.busy = false; stopStretch(); render();
    } catch (e) {
      if (state !== s) return;
      s.busy = false; s.error = e.message; render();
    }
  }

  // ---------- choosing the stretch: handles on the map ----------
  // The curb as drawn (tile centerline, pushed to its road edge by the same offset the curb layer uses), as runs in
  // order along it: a curb that wraps a corner is drawn as one run per street, with a gap at the corner, and the
  // handles slide across all of them (fractions are of the runs' total length). The whole curb starts selected; a handle at each end slides along it. The selection stays bright, the rest is dimmed, and
  // the curb's meters show as dots to line the ends up with the signs. Fractions are measured along the centerline.
  const KY = 1 / Math.cos((42.35 * Math.PI) / 180); // degrees of latitude are longer than of longitude here
  function startStretch() {
    const s = state, map = d.map;
    const parts = map.queryRenderedFeatures({ layers: DRAW_LAYERS }).filter((f) => f.id === s.feature.id)
      .flatMap((f) => (f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates]));
    s.runs = runsOf(parts).filter((r) => r.length >= 2);
    s.props = { side: s.feature.properties.side ?? 0, rc: s.feature.properties.rc ?? "" };
    if (!s.runs.length) return; // not drawn here: the whole curb it is
    // Per run: where it starts along the curb, and the running length at each vertex.
    let start = 0;
    s.meas = s.runs.map((r) => {
      const cum = [0];
      for (let k = 1; k < r.length; k++) cum.push(cum[k - 1] + gdist(r[k], r[k - 1]));
      const m = { start, cum, len: cum.at(-1) };
      start += m.len;
      return m;
    });
    s.total = start || 1;
    s.meterFracs = metersOnCurb();
    const handle = (i) => {
      const el = document.createElement("div");
      el.className = "stretch-handle"; el.setAttribute("aria-label", i ? "End of the stretch" : "Start of the stretch");
      const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(pointAt(s.frac[i])).addTo(map);
      m.on("drag", () => {
        const gap = Math.min(0.5, 2 / (span() || 1)), f = fracAt(m.getLngLat());
        s.frac[i] = i ? Math.max(f, s.frac[0] + gap) : Math.min(f, s.frac[1] - gap);
        placeStretch(false);
      });
      m.on("dragend", () => render());
      return m;
    };
    s.handles = [handle(0), handle(1)];
    s.onMove = () => placeStretch(false);
    map.on("move", s.onMove);
    // Frame the curb in the part of the map the editor leaves free.
    const all = s.runs.flat(), lons = all.map((p) => p[0]), lats = all.map((p) => p[1]), phoneView = innerWidth <= 640;
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
      padding: phoneView ? { top: 60, bottom: Math.round(innerHeight * 0.55) + 30, left: 40, right: 40 } : { top: 80, bottom: 80, left: (d.$("#panel")?.offsetWidth || 0) + 70, right: 380 + 100 }, // between the side panel and the editor
      maxZoom: 19.5, duration: 600,
    });
    placeStretch(false);
  }
  function stopStretch() {
    const s = state, map = d.map;
    if (s?.onMove) map.off("move", s.onMove);
    for (const m of s?.handles || []) m.remove();
    if (s) { s.handles = null; s.onMove = null; }
    for (const id of ["edit-ticks", "edit-stretch", "edit-dim"]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of ["edit-stretch", "edit-ticks"]) if (map.getSource(id)) map.removeSource(id);
  }
  const gdist = (p, q) => Math.hypot(p[0] - q[0], (p[1] - q[1]) * KY);
  // Pieces of one drawn curb → its runs, in order along the curb. Pieces that touch are joined (a curb crossing a tile
  // edge); the runs are then strung together nearest end to nearest end, starting from the end that's farthest from
  // everything else.
  function runsOf(parts) {
    const left = parts.map((p) => [...p]), runs = [];
    while (left.length) runs.push(chain(left)); // chain() takes the pieces it joins out of `left`
    if (runs.length < 2) return runs;
    const ends = (r) => [r[0], r.at(-1)];
    let first = null;
    runs.forEach((r, i) => ends(r).forEach((e, which) => {
      const d = Math.min(...runs.filter((_, j) => j !== i).flatMap((o) => ends(o).map((x) => gdist(e, x))));
      if (!first || d > first.d) first = { i, which, d };
    }));
    const out = [first.which === 0 ? runs[first.i] : [...runs[first.i]].reverse()], rest = runs.filter((_, j) => j !== first.i);
    while (rest.length) {
      const tail = out.at(-1).at(-1);
      let best = null;
      rest.forEach((r, j) => ends(r).forEach((e, which) => { const d = gdist(tail, e); if (!best || d < best.d) best = { j, which, d }; }));
      const r = rest.splice(best.j, 1)[0];
      out.push(best.which === 0 ? r : [...r].reverse());
    }
    return out;
  }
  // Which run a length along the curb falls in, and where within it.
  function locate(t) {
    const s = state;
    let i = 0;
    while (i < s.runs.length - 1 && t > s.meas[i].start + s.meas[i].len) i++;
    return { i, t: Math.max(0, Math.min(s.meas[i].len, t - s.meas[i].start)) };
  }
  // Where a fraction of the curb is drawn: on the centerline, pushed sideways by the curb's offset at this zoom.
  function pointAt(f) {
    const s = state, map = d.map, { i, t } = locate(Math.max(0, Math.min(1, f)) * s.total), line = s.runs[i], cum = s.meas[i].cum;
    let k = 1;
    while (k < line.length - 1 && cum[k] < t) k++;
    const a = line[k - 1], b = line[k], u = (t - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
    const pa = map.project(a), pb = map.project(b), L = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
    const off = (s.props.side || 0) * curbOffsetPx(s.props.rc || "minor", map.getZoom());
    const x = pa.x + (pb.x - pa.x) * u - ((pb.y - pa.y) / L) * off, y = pa.y + (pb.y - pa.y) * u + ((pb.x - pa.x) / L) * off;
    return map.unproject([x, y]);
  }
  // The fraction of the curb nearest a point on screen (the offset doesn't change which part of the curb is nearest).
  function fracAt(lngLat) {
    const s = state, map = d.map, q = map.project(lngLat);
    let best = { d: Infinity, f: 0 };
    s.runs.forEach((line, i) => {
      const { start, cum } = s.meas[i];
      for (let k = 1; k < line.length; k++) {
        const a = map.project(line[k - 1]), b = map.project(line[k]), dx = b.x - a.x, dy = b.y - a.y;
        const u = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        const dist = Math.hypot(q.x - a.x - u * dx, q.y - a.y - u * dy);
        if (dist < best.d) best = { d: dist, f: (start + cum[k - 1] + u * (cum[k] - cum[k - 1])) / s.total };
      }
    });
    return best.f;
  }
  // Meters standing beside this curb (within ~8 m), as fractions along it. They're in the tiles even while hidden.
  function metersOnCurb() {
    const map = d.map;
    if (!map.getSource("curbs")) return [];
    const px = 8 / mpp(map.getZoom()), seen = new Set(), out = [];
    for (const m of map.querySourceFeatures("curbs", { sourceLayer: "meters" })) {
      const c = m.geometry.coordinates, key = c.join();
      if (seen.has(key)) continue;
      seen.add(key);
      const f = fracAt({ lng: c[0], lat: c[1] }), p = map.project(pointAt(f)), q = map.project(c);
      if (Math.hypot(p.x - q.x, p.y - q.y) < px + 12) out.push(f);
    }
    return out;
  }
  function placeStretch(full = true) {
    const s = state, map = d.map;
    if (!s?.runs?.length) return;
    s.handles?.forEach((m, i) => m.setLngLat(pointAt(s.frac[i])));
    // The part of each run between two fractions of the whole curb.
    const pieces = (x, y, kind) => s.runs.flatMap((line, i) => {
      const r0 = s.meas[i].start / s.total, r1 = (s.meas[i].start + s.meas[i].len) / s.total, lo = Math.max(x, r0), hi = Math.min(y, r1);
      return hi - lo > 1e-6 ? [{ type: "Feature", properties: { ...s.props, kind }, geometry: { type: "LineString", coordinates: slice(line, (lo - r0) / ((r1 - r0) || 1), (hi - r0) / ((r1 - r0) || 1)) } }] : [];
    });
    const [a, b] = s.frac;
    const lines = { type: "FeatureCollection", features: [...pieces(a, b, "sel"), ...(a > 0.001 ? pieces(0, a, "dim") : []), ...(b < 0.999 ? pieces(b, 1, "dim") : [])] };
    const ticks = { type: "FeatureCollection", features: (s.meterFracs || []).map((f) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: pointAt(f).toArray() } })) };
    const light = theme() === "light";
    if (map.getSource("edit-stretch")) { map.getSource("edit-stretch").setData(lines); map.getSource("edit-ticks").setData(ticks); }
    else {
      const offset = map.getPaintProperty("zone-line", "line-offset");
      map.addSource("edit-stretch", { type: "geojson", data: lines });
      map.addSource("edit-ticks", { type: "geojson", data: ticks });
      map.addLayer({ id: "edit-dim", type: "line", source: "edit-stretch", filter: ["==", ["get", "kind"], "dim"], layout: { "line-cap": "round" },
        paint: { "line-color": light ? "#eef0f3" : "#0d0f14", "line-opacity": 0.75, "line-width": ["interpolate", ["exponential", 2], ["zoom"], 14, 4, 18, 8, 20, 16], "line-offset": offset } });
      map.addLayer({ id: "edit-stretch", type: "line", source: "edit-stretch", filter: ["==", ["get", "kind"], "sel"], layout: { "line-cap": "round" },
        paint: { "line-color": light ? "#15181f" : "#ffffff", "line-opacity": 0.5, "line-width": ["interpolate", ["exponential", 2], ["zoom"], 14, 5, 18, 13, 20, 24], "line-offset": offset } });
      map.addLayer({ id: "edit-ticks", type: "circle", source: "edit-ticks",
        paint: { "circle-radius": 3.5, "circle-color": light ? "#1a73e8" : "#8ab4f8", "circle-stroke-width": 1.5, "circle-stroke-color": light ? "#ffffff" : "#0d0f14" } });
    }
    if (full) render();
    else { const lbl = d.$("#popup .ed-stretch b"); if (lbl) lbl.textContent = stretchLabel(); }
  }

  return { actions, close, curbInfo, get editing() { return !!state; } };
}
