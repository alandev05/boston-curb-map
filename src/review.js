// Moderation page (/review, served from review.html): the queue of community corrections, each shown as current vs proposed rules by
// weekday, with the photo, note and where it is. Accept / reject / revert go through /api/review (X-Admin-Token).
import "./style.css";
import { CATEGORIES, daySchedule, fmtTime, fmtRate, ruleOf, isRealPolicy } from "./rules.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const session = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} } };
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], NAME = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

let status = "pending", publicPolicies = null, manifest = null;

async function api(path, body) {
  const r = await fetch(path, { method: body ? "POST" : "GET", headers: { "X-Admin-Token": session.get("adminToken") || "", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const js = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(js.error || `${r.status}`);
  return js;
}
async function loadPublic() {
  if (publicPolicies) return;
  try {
    manifest = await (await fetch("/data/manifest.json", { cache: "no-cache" })).json();
    publicPolicies = await (await fetch(`/data/policies.json?v=${manifest.version}`)).json();
  } catch { publicPolicies = {}; }
}

// A set of rules as one line per group of weekdays with the same day ("Mon–Fri: 8 AM–6 PM Paid meter (2 hr, $3.75/hr) · …").
function week(pols, ids) {
  const zone = { curb_policy_ids: ids };
  const clock = (m) => fmtTime(`${Math.floor(m / 60)}:${m % 60}`);
  const label = (v) => {
    if (!v.policy) return "no posted rule";
    if (v.meterFree) return "free (meter off)";
    const r = ruleOf(v.policy), extra = [r.max_stay ? `${r.max_stay < 60 ? `${r.max_stay} min` : `${r.max_stay / 60} hr`}` : null, fmtRate(r)].filter(Boolean);
    return `${CATEGORIES[v.category]?.label || v.category}${extra.length ? ` (${extra.join(", ")})` : ""}`;
  };
  const lines = DAYS.map((d) => daySchedule(zone, pols, d, undefined, { meterFree: d === "sun" })
    .map((b) => `${b.from === 0 && b.to === 1440 ? "all day" : `${clock(b.from)}–${clock(b.to)}`} ${label(b.v)}`).join(" · "));
  const groups = [];
  DAYS.forEach((d, i) => { const g = groups.at(-1); if (g && g.text === lines[i]) g.days.push(d); else groups.push({ days: [d], text: lines[i] }); });
  return groups.map((g) => `<li><b>${NAME[g.days[0]]}${g.days.length > 1 ? `–${NAME[g.days.at(-1)]}` : ""}</b> ${esc(g.text)}</li>`).join("");
}
const proposed = (rules) => { const pols = {}, ids = (rules || []).map((r, i) => { const id = `p${i}`; pols[id] = { ...r, curb_policy_id: id }; return id; }); return week(pols, ids); };
const current = (basedOn) => {
  const ids = String(basedOn || "").split(",").filter((id) => id && !id.startsWith("~") && isRealPolicy(publicPolicies[id]));
  return ids.length ? week(publicPolicies, ids) : `<li class="muted">No rules recorded (or from an older build)</li>`;
};

function card(s) {
  const when = new Date(s.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const stretch = s.stretch_from != null ? `${Math.round(s.stretch_from)}–${Math.round(s.stretch_to)} m of ${Math.round(s.curb_length || 0)} m` : `whole curb${s.curb_length ? ` (${Math.round(s.curb_length)} m)` : ""}`;
  const mapLink = s.curb_lng != null ? `<a href="/?at=${s.curb_lng},${s.curb_lat}" target="_blank" rel="noopener">Open on map</a>` : "";
  const here = s.lat != null ? `<a href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=19/${s.lat}/${s.lng}" target="_blank" rel="noopener">Submitter's location</a>${s.accuracy_m ? ` (±${Math.round(s.accuracy_m)} m)` : ""}` : "";
  const stale = manifest && s.data_version && s.data_version !== manifest.version ? `<span class="muted">· seen on an older build</span>` : "";
  const actions = s.status === "pending"
    ? `<button class="primary" data-act="accept">Accept</button><button class="ghost" data-act="reject">Reject</button>`
    : s.status === "accepted" ? `<button class="ghost" data-act="revert">Revert</button>` : "";
  return `<article class="rv-card" data-id="${s.id}" data-curb="${s.curb_zone_id}">
    <div class="rv-meta"><b>${esc(when)}</b> · ${esc(stretch)} · ${s.confirmations ? `${s.confirmations + 1} agree` : "no confirmations yet"} ${stale}</div>
    <div class="rv-meta muted">Curb ${esc(s.curb_zone_id)} ${mapLink ? `· ${mapLink}` : ""} ${here ? `· ${here}` : ""}</div>
    <div class="rv-cols">
      <section><h3>Current</h3><ul class="rv-week">${current(s.based_on)}</ul></section>
      <section><h3>Proposed</h3><ul class="rv-week">${proposed(s.rules)}</ul></section>
    </div>
    ${s.note ? `<p class="rv-note">“${esc(s.note)}”</p>` : ""}
    ${s.photo_url ? `<a href="${s.photo_url}" target="_blank" rel="noopener"><img class="rv-photo" src="${s.photo_url}" alt="Submitted photo of the sign"></a>` : ""}
    ${s.status !== "pending" ? `<p class="rv-meta muted">${esc(s.status)}${s.reviewer ? ` by ${esc(s.reviewer)}` : ""}${s.reviewed_at ? ` · ${new Date(s.reviewed_at).toLocaleString()}` : ""}${s.review_note ? ` — “${esc(s.review_note)}”` : ""}</p>` : ""}
    <div class="rv-actions">${actions ? `<input class="rv-note-in" placeholder="Note (optional)" maxlength="1000">${actions}` : ""}<button class="link" data-act="history">History</button></div>
    <ol class="rv-history" hidden></ol>
  </article>`;
}

async function load() {
  $("#msg").textContent = "Loading…";
  try {
    await loadPublic();
    const { submissions } = await api(`/api/review?status=${status}`);
    $("#list").innerHTML = submissions.map(card).join("") || `<p class="muted">Nothing ${status}.</p>`;
    $("#msg").textContent = `${submissions.length} ${status}`;
  } catch (e) { $("#list").innerHTML = ""; $("#msg").textContent = e.message === "admin token required" ? "Enter the admin token." : `Couldn't load: ${e.message}`; }
}

$("#login").addEventListener("submit", (e) => {
  e.preventDefault();
  session.set("adminToken", $("#token").value.trim()); store.set("reviewer", $("#reviewer").value.trim());
  $("#token").value = ""; load();
});
$("#reviewer").value = store.get("reviewer") || "";
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-status]"); if (!b) return;
  status = b.dataset.status;
  for (const t of document.querySelectorAll("#tabs button")) t.setAttribute("aria-selected", String(t === b));
  load();
});
$("#list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"), cardEl = b?.closest(".rv-card");
  if (!b || !cardEl) return;
  if (b.dataset.act === "history") {
    const ol = cardEl.querySelector(".rv-history");
    if (!ol.hidden) { ol.hidden = true; return; }
    try {
      const { events } = await api(`/api/review?curb=${cardEl.dataset.curb}`);
      ol.innerHTML = events.map((ev) => `<li><span class="muted">${new Date(ev.at).toLocaleString()}</span> ${esc(ev.action)} · ${esc(ev.actor.replace(/^device:(.{8}).*/, "device $1…"))}${ev.detail?.note ? ` — “${esc(ev.detail.note)}”` : ""}</li>`).join("") || "<li>No events.</li>";
      ol.hidden = false;
    } catch (err) { $("#msg").textContent = err.message; }
    return;
  }
  b.disabled = true;
  try {
    const r = await api("/api/review", { id: cardEl.dataset.id, decision: b.dataset.act, note: cardEl.querySelector(".rv-note-in")?.value || "", reviewer: store.get("reviewer") || "moderator" });
    $("#msg").textContent = `${b.dataset.act === "accept" ? "Accepted" : b.dataset.act === "reject" ? "Rejected" : "Reverted"}${r.rebuild ? " — rebuilding the map" : b.dataset.act !== "reject" ? " — reaches the map on the next deploy" : ""}.`;
    cardEl.remove();
  } catch (err) { b.disabled = false; $("#msg").textContent = err.message; }
});
if (session.get("adminToken")) load(); else $("#msg").textContent = "Enter the admin token.";
