// Community submissions, inside the curb popup: "Looks right", pending corrections ("Matches what I see"), and the
// "Fix this curb" editor (rule cards prefilled from the curb's current rules, a stretch of the curb, a live preview of
// the day, an optional note / photo / location). Everything goes through the API (api/submit.js etc.); nothing is
// written to the map until a moderator accepts it and the data is rebuilt.
import { RULE_TYPES, WEEK, LIMITS, newCard, cardToPolicy, cardsFor } from "./submission.js";
import { CATEGORIES, catColor, fmtTime, isRealPolicy, overriddenBy } from "./rules.js";

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
    el.innerHTML = `<div class="pending"></div><div class="act-row"><button type="button" class="act ok">✓ Looks right</button><button type="button" class="act fix">✎ Fix this curb</button></div>`;
    const info = await curbInfo(feature.id);
    if (!el.isConnected) return;
    if (!info) { el.remove(); return; }
    const confirmedKey = `confirmed:${info.zone}`, ok = el.querySelector(".ok");
    if (d.store.get(confirmedKey)) { ok.textContent = "✓ You confirmed this"; ok.disabled = true; }
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        await api("/api/submit", { kind: "confirm", curb_zone_id: info.zone, stretch: info.from != null ? [info.from, info.to] : null, curb_length: info.len, based_on: d.rulesets()[info.rs], data_version: d.manifest()?.version, device_id: deviceId() });
        d.store.set(confirmedKey, new Date().toISOString().slice(0, 10)); ok.textContent = "✓ Thanks — noted";
      } catch (e) { ok.disabled = false; ok.textContent = "✓ Looks right"; ok.title = e.message; }
    };
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
      feature, info, back, point: lngLat ? [+lngLat.lng.toFixed(6), +lngLat.lat.toFixed(6)] : null, cards, range: [a, b], stretch: [a, b], part: false,
      note: "", photo: null, loc: false, day: dayOf(d.startTime()), done: false, busy: false, error: null,
    };
    const root = d.$("#popup");
    root.classList.add("editing"); document.body.classList.add("editing");
    root.onclick = onClick; root.oninput = onInput; root.onchange = onChange;
    drawStretch(true);
    render();
  }
  const dayOf = (t) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][t.getDay()];
  function close() {
    if (!state) return;
    const root = d.$("#popup");
    root.classList.remove("editing"); document.body.classList.remove("editing");
    root.onclick = root.oninput = root.onchange = null;
    drawStretch(false);
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
    const L = s.range[1] - s.range[0], issue = problem();
    root.innerHTML = `
      <div class="ed-head"><b>Fix this curb</b><button type="button" class="x" data-act="cancel" aria-label="close">×</button></div>
      <p class="ed-hint">Make this match the sign. Each card is one rule; the preview shows what the map would say.</p>
      <div class="ed-sec">
        <div class="seg"><button type="button" data-act="whole" aria-pressed="${!s.part}">Whole curb · ${Math.round(L)} m</button><button type="button" data-act="part" aria-pressed="${s.part}">Only part of it</button></div>
        ${s.part ? `<div class="range2"><input type="range" data-act="sa" min="${s.range[0]}" max="${s.range[1]}" step="0.5" value="${s.stretch[0]}" aria-label="Stretch start"><input type="range" data-act="sb" min="${s.range[0]}" max="${s.range[1]}" step="0.5" value="${s.stretch[1]}" aria-label="Stretch end"></div>
          <small class="muted stretch-label">${stretchLabel()}</small>` : ""}
      </div>
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
  const stretchLabel = () => `${Math.round(state.stretch[0] - state.range[0])}–${Math.round(state.stretch[1] - state.range[0])} m of ${Math.round(state.range[1] - state.range[0])} m (${Math.round(state.stretch[1] - state.stretch[0])} m)`;

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
      case "whole": s.part = false; s.stretch = [...s.range]; drawStretch(true); break;
      case "part": s.part = true; drawStretch(true); break;
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
    else if (el.dataset.act === "sa" || el.dataset.act === "sb") {
      const v = +el.value, gap = Math.min(2, (s.range[1] - s.range[0]) / 2);
      if (el.dataset.act === "sa") s.stretch[0] = Math.min(v, s.stretch[1] - gap); else s.stretch[1] = Math.max(v, s.stretch[0] + gap);
      el.value = el.dataset.act === "sa" ? s.stretch[0] : s.stretch[1];
      d.$("#popup .stretch-label").textContent = stretchLabel();
      drawStretch(true);
    }
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
    const whole = !s.part && s.info.from == null;
    try {
      await api("/api/submit", {
        kind: "correction", curb_zone_id: s.info.zone, curb_length: s.info.len, point: s.point,
        stretch: whole ? null : [+s.stretch[0].toFixed(1), +s.stretch[1].toFixed(1)],
        rules: s.cards.map((c, i) => { const { curb_policy_id, ...p } = cardToPolicy(c, String(i)); return p; }),
        based_on: d.rulesets()[s.info.rs], data_version: d.manifest()?.version,
        note: s.note.trim() || null, photo: s.photo, location, device_id: deviceId(),
      });
      if (state !== s) return;
      s.done = true; s.busy = false; drawStretch(false); render();
    } catch (e) {
      if (state !== s) return;
      s.busy = false; s.error = e.message; render();
    }
  }

  // ---------- the chosen stretch, highlighted on the map ----------
  // The drawn curb (tile geometry, offset to its road edge like the curb itself); the stretch is the same share of it.
  function drawStretch(on) {
    const map = d.map;
    if (!on || !state) {
      if (map.getLayer("edit-stretch")) map.removeLayer("edit-stretch");
      if (map.getSource("edit-stretch")) map.removeSource("edit-stretch");
      return;
    }
    const s = state;
    if (!s.line) {
      const parts = map.queryRenderedFeatures({ layers: DRAW_LAYERS }).filter((f) => f.id === s.feature.id)
        .flatMap((f) => (f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates]));
      s.line = chain(parts);
      s.props = { side: s.feature.properties.side ?? 0, rc: s.feature.properties.rc ?? "" };
    }
    const span = s.range[1] - s.range[0] || 1, a = (s.stretch[0] - s.range[0]) / span, b = (s.stretch[1] - s.range[0]) / span;
    const data = { type: "Feature", properties: s.props, geometry: { type: "LineString", coordinates: slice(s.line, a, b) } };
    if (map.getSource("edit-stretch")) map.getSource("edit-stretch").setData(data);
    else {
      map.addSource("edit-stretch", { type: "geojson", data });
      map.addLayer({ id: "edit-stretch", type: "line", source: "edit-stretch", layout: { "line-cap": "round" },
        paint: { "line-color": theme() === "light" ? "#15181f" : "#ffffff", "line-opacity": 0.55, "line-width": ["interpolate", ["exponential", 2], ["zoom"], 14, 4, 18, 12, 20, 22], "line-offset": map.getPaintProperty("zone-line", "line-offset") } });
    }
  }
  // Tile pieces of one curb, joined end to end (a curb can cross a tile edge).
  function chain(parts) {
    if (!parts.length) return [];
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
    let line = [...parts.shift()];
    while (parts.length) {
      const i = parts.findIndex((p) => near(p[0], line.at(-1)) || near(p.at(-1), line.at(-1)) || near(p.at(-1), line[0]) || near(p[0], line[0]));
      if (i < 0) break;
      const p = parts.splice(i, 1)[0];
      if (near(p[0], line.at(-1))) line = [...line, ...p.slice(1)];
      else if (near(p.at(-1), line.at(-1))) line = [...line, ...p.reverse().slice(1)];
      else if (near(p.at(-1), line[0])) line = [...p, ...line.slice(1)];
      else line = [...p.reverse(), ...line.slice(1)];
    }
    return line;
  }
  function slice(line, a, b) {
    const seg = line.slice(1).map((p, k) => Math.hypot(p[0] - line[k][0], (p[1] - line[k][1]) * 1.35));
    const total = seg.reduce((x, y) => x + y, 0) || 1, out = [];
    let run = 0;
    for (let k = 0; k < seg.length; k++) {
      const p = line[k], q = line[k + 1], from = run / total, to = (run + seg[k]) / total;
      const at = (f) => { const u = (f - from) / ((to - from) || 1); return [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u]; };
      if (to >= a && from <= b) { if (!out.length) out.push(at(Math.max(a, from))); out.push(to <= b ? q : at(b)); }
      run += seg[k];
    }
    return out.length >= 2 ? out : line;
  }

  return { actions, close, get editing() { return !!state; } };
}
