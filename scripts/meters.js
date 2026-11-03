// City parking meters (BTD's "Parking Meters" on Analyze Boston / the City's ArcGIS Hub) → curb rules.
// Each meter carries its own schedule:
//   PAY_POLICY   "08:00AM-08:00PM MON-SAT $0.25 120": paid hours and the time limit in minutes (the dollar figure is
//                the minimum payment, not an hourly rate, so the curb feed's rate is kept for display)
//   PARK_NO_PAY  the hours you park free there: exactly the rest of the week, which is how a metered rule already
//                behaves outside its hours (see verdict), so it needs no rule of its own
//   TOW_AWAY     "04:00PM-06:00PM MON-FRI": rush-hour tow-away, no stopping
// Two things change on the curbs they stand beside (matched on the city's own curb geometry, before snapping):
// 1. The meter's schedule replaces the curb feed's metered rule (or gives a "no data" curb one): the meters are
//    maintained per space by BTD, the feed's rule is a block-level copy.
// 2. Spot signs stop taking over long curbs. The feed often lists every sign on a block in one zone, so a hydrant's
//    all-day "no stopping" (priority 1) would paint a 90 m metered block red. On a curb that also has general
//    parking or meters and is long enough that the sign can only cover part of it, the sign's id is written "~id":
//    it no longer grades the curb (no policy has that id) and the popup lists it as "on part of this curb".
//    Meters are proof too: a restriction in force through all of a curb's meter hours ("No Stopping" all day,
//    "Parking Resident Only", "Bus Only") can't cover the whole curb, or nobody could use those meters. Restrictions
//    that only cover some of those hours (street cleaning 8 AM–12 PM, 4–6 PM tow-away) still apply to all of it.
import { isRealPolicy, ruleOf, isMetered, categorize, policyActive } from "../src/rules.js";
import { projector, lineLength } from "./snap.js";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// "08:00AM" → "08:00", "08:00PM" → "20:00", "24:00AM" → "24:00".
const clock = (s) => {
  const m = String(s).match(/(\d{1,2}):(\d\d)\s*(AM|PM)/i);
  if (!m) return null;
  let h = +m[1];
  if (h !== 24) h = (h % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0);
  return `${String(h).padStart(2, "0")}:${m[2]}`;
};
const dayRange = (s) => {
  const [a, b = a] = s.toLowerCase().split("-").map((d) => DAYS.indexOf(d));
  if (a < 0 || b < 0) return null;
  const out = [];
  for (let i = a; ; i = (i + 1) % 7) { out.push(DAYS[i]); if (i === b) break; }
  return out;
};
// "08:00AM-04:00PM MON-FRI $0.25 120, 08:00AM-06:00PM SAT $0.25 120" → [{ days, start, end, max }]
export function parseMeterSchedule(str) {
  return String(str || "").split(/\s*,\s*/).map((part) => {
    const m = part.match(/^(\S+)-(\S+)\s+([A-Z]{3}(?:-[A-Z]{3})?)(?:\s+\$[\d.]+\s+(\d+))?/i);
    const days = m && dayRange(m[3]), start = m && clock(m[1]), end = m && clock(m[2]);
    return days && start && end ? { days, start, end, max: m[4] ? +m[4] : null } : null;
  }).filter(Boolean);
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export const SPOT = /Fire Hydrant|Bus Stop|Valet|Loading|HP\/DV|Emergency Use|Pick-Up\/Drop-Off|Rideshare/i;
const spans = (sched) => sched.map(({ days, start, end }) => ({ days_of_week: days, time_of_day_start: start, time_of_day_end: end }));

// Rule ids end up in comma-joined rule sets, so they're a short hash of what defines the rule, never the raw text.
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
// One rule per distinct schedule (and carried rate): meters on a block share them.
function payPolicy(pay, rates, policies) {
  const max = Math.max(0, ...parseMeterSchedule(pay).map((s) => s.max || 0)) || null;
  const id = `meter-${hash(`${pay}|${JSON.stringify(rates || null)}`)}`;
  policies[id] ||= {
    curb_policy_id: id, priority: 83, description: "Parking meter", source: "meters",
    rules: [{ activity: "parking", max_stay: max, max_stay_unit: max ? "minute" : null }],
    rates: rates?.length ? rates : [{ rate: null, rate_unit: "hour" }], // a rate (even unknown) is what makes it "paid"
    time_spans: spans(parseMeterSchedule(pay)),
  };
  return id;
}
function towPolicy(tow, policies) {
  const id = `meter-tow-${hash(tow)}`;
  policies[id] ||= {
    curb_policy_id: id, priority: 5, description: "Tow-away zone (meter)", reason: "tow-away", source: "meters",
    rules: [{ activity: "no stopping" }], time_spans: spans(parseMeterSchedule(tow)),
  };
  return id;
}

// features: raw curb zones (city geometry); policies: mutated (meter rules added); meters: GeoJSON points.
// Returns new features with updated curb_policy_ids, and stats.
export function assignMeters(features, policies, meters, { maxDist = 6, log = () => {} } = {}) {
  const stats = { meters: 0, matched: 0, curbs: 0, replacedFeedMeter: 0, gaveNoDataCurb: 0, tow: 0, spotDemoted: 0, spotCurbs: 0 };
  const lat0 = features.find((f) => f.geometry)?.geometry.coordinates.flat(3)[1] ?? 42.35;
  const P = projector(lat0), cell = 25, grid = new Map(), segs = [];
  features.forEach((f, zi) => {
    if (f.geometry?.type !== "LineString") return;
    const c = f.geometry.coordinates.map(P.fwd);
    for (let k = 1; k < c.length; k++) {
      const id = segs.push({ a: c[k - 1], b: c[k], zi }) - 1, { a, b } = segs[id];
      for (let i = Math.floor(Math.min(a[0], b[0]) / cell); i <= Math.floor(Math.max(a[0], b[0]) / cell); i++)
        for (let j = Math.floor(Math.min(a[1], b[1]) / cell); j <= Math.floor(Math.max(a[1], b[1]) / cell); j++) {
          const key = `${i},${j}`; (grid.get(key) || grid.set(key, []).get(key)).push(id);
        }
    }
  });
  // Each active meter goes to the curb it stands beside: nearest line whose perpendicular foot lands on it.
  const onCurb = new Map(); // zone index → [meter props]
  for (const m of meters) {
    const p = m.properties || {};
    if (m.geometry?.type !== "Point" || (p.METER_STATE && p.METER_STATE !== "ACTIVE") || !p.PAY_POLICY) continue;
    stats.meters++;
    const q = P.fwd(m.geometry.coordinates), i0 = Math.floor(q[0] / cell), j0 = Math.floor(q[1] / cell);
    let best = null;
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const id of grid.get(`${i},${j}`) || []) {
      const { a, b, zi } = segs[id], dx = b[0] - a[0], dy = b[1] - a[1];
      const t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1);
      if (t < 0 || t > 1) continue;
      const d = Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
      if (d <= maxDist && (!best || d < best.d)) best = { d, zi };
    }
    if (!best) continue;
    stats.matched++;
    (onCurb.get(best.zi) || onCurb.set(best.zi, []).get(best.zi)).push(p);
  }
  const out = features.map((f, zi) => {
    if (!f.geometry || f.geometry.type !== "LineString") return f;
    let ids = [...(f.properties.curb_policy_ids || [])];
    const here = onCurb.get(zi) || [];
    if (here.length) {
      stats.curbs++;
      const feedMeters = ids.filter((id) => policies[id] && isMetered(policies[id]));
      const rates = feedMeters.map((id) => policies[id].rates || ruleOf(policies[id]).rate).find((r) => r?.length && r[0].rate != null) || null;
      if (feedMeters.length) stats.replacedFeedMeter++;
      if (!ids.some((id) => isRealPolicy(policies[id]))) stats.gaveNoDataCurb++;
      ids = ids.filter((id) => !feedMeters.includes(id));
      for (const pay of new Set(here.map((p) => p.PAY_POLICY))) ids.push(payPolicy(pay, rates, policies));
      for (const tow of new Set(here.map((p) => p.TOW_AWAY).filter(Boolean))) { ids.push(towPolicy(tow, policies)); stats.tow++; }
    }
    // Every 30 minutes of the meters' paid hours: a restriction in force at all of them covers only part of the curb.
    const payTimes = [...new Set(here.map((p) => p.PAY_POLICY))].flatMap(parseMeterSchedule)
      .flatMap(({ days, start, end }) => { const a = toMin(start), b = toMin(end), t = []; for (const d of days) for (let m = a; m < b; m += 30) t.push([d, m]); return t; });
    const blocksMeters = (p) => payTimes.length && !isMetered(p) && !["free", "paid", "unknown"].includes(categorize(ruleOf(p))) && payTimes.every(([d, m]) => policyActive(p, d, m));
    // Spot signs on a long curb that also has general parking or meters cover only part of it.
    const len = lineLength(f.geometry.coordinates);
    const general = here.length || ids.some((id) => {
      const p = policies[id];
      if (!p || !isRealPolicy(p) || SPOT.test(p.description || "")) return false;
      const r = ruleOf(p);
      return isMetered(p) || (/^parking$/i.test(r.activity || "") && !r.user_classes?.length);
    });
    if (general) {
      let demoted = 0;
      ids = ids.map((id) => {
        const p = policies[id], d = p?.description || "";
        if (!p || !isRealPolicy(p) || String(id).startsWith("meter-")) return id;
        const spot = SPOT.test(d) && (len >= 30 || (here.length && len >= 12) || (/Fire Hydrant/i.test(d) && len >= 20));
        if (!spot && !(here.length && blocksMeters(p))) return id;
        demoted++;
        return `~${id}`;
      });
      if (demoted) { stats.spotDemoted += demoted; stats.spotCurbs++; }
    }
    return { ...f, properties: { ...f.properties, curb_policy_ids: ids } };
  });
  log(`  meters: ${stats.matched} of ${stats.meters} active meters on ${stats.curbs} curbs (their schedule replaced the feed's meter rule on ${stats.replacedFeedMeter}, gave ${stats.gaveNoDataCurb} no-data curbs a schedule, ${stats.tow} tow-away rules); spot signs on part of a longer curb: ${stats.spotDemoted} on ${stats.spotCurbs} curbs`);
  return { features: out, stats };
}
