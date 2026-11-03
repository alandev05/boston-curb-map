// Accepted community corrections → curb rules (runs first in the build, on the city's own geometry).
// A correction covers a whole curb, or a stretch of it in meters along the city's line. The curb is cut at stretch
// ends; each piece keeps the city's rules, or takes the correction's rules instead (`_community`: the submission id),
// and later steps (meters, street sweeping) leave community pieces alone: someone looked at the sign.
// Every piece records where it lies on the original curb (`_from`/`_to`, meters), so the map can send new
// corrections against the same city curb id.
import { projector, lineLength } from "./snap.js";

// The part of a LineString between `a` and `b` meters along it.
export function lineSlice(coords, a, b, P = projector(coords[0][1])) {
  const pts = coords.map(P.fwd), out = [];
  let run = 0;
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k - 1], q = pts[k], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const lerp = (d) => [p[0] + ((q[0] - p[0]) * (d - run)) / (L || 1), p[1] + ((q[1] - p[1]) * (d - run)) / (L || 1)];
    if (run + L >= a && run <= b) {
      if (!out.length) out.push(lerp(Math.max(a, run)));
      if (run + L <= b) out.push(q); else { out.push(lerp(b)); break; }
    }
    run += L;
  }
  return out.filter((p, i) => !i || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 0.01).map((p) => P.inv(p).map((n) => +n.toFixed(7)));
}

// accepted: [{ id, curb_zone_id, stretch_from, stretch_to, curb_length, rules, reviewed_at }]
export function applyCommunity(features, policies, accepted, { log = () => {} } = {}) {
  const stats = { corrections: accepted.length, curbs: 0, pieces: 0, redrawn: 0, missing: 0 };
  const byZone = new Map();
  for (const s of accepted) (byZone.get(s.curb_zone_id) || byZone.set(s.curb_zone_id, []).get(s.curb_zone_id)).push(s);
  const seen = new Set(), out = [];
  for (const f of features) {
    const zid = f.properties?.curb_zone_id, subs = byZone.get(zid);
    if (!subs || f.geometry?.type !== "LineString") { out.push(f); continue; }
    seen.add(zid); stats.curbs++;
    const coords = f.geometry.coordinates, L = lineLength(coords);
    if (subs.some((s) => s.curb_length && Math.abs(s.curb_length - L) > 5)) stats.redrawn++; // the city redrew it since
    // Latest review wins where corrections overlap; whole-curb corrections span [0, L].
    const spans = subs.map((s) => ({ s, a: s.stretch_from == null ? 0 : Math.max(0, s.stretch_from), b: s.stretch_from == null ? L : Math.min(L, s.stretch_to) }))
      .filter((x) => x.b - x.a >= 0.5).sort((x, y) => String(x.s.reviewed_at).localeCompare(String(y.s.reviewed_at)));
    const cuts = [...new Set([0, L, ...spans.flatMap((x) => [x.a, x.b])])].sort((x, y) => x - y);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i], b = cuts[i + 1];
      if (b - a < 0.5) continue;
      const win = spans.filter((x) => x.a <= a && x.b >= b).at(-1)?.s;
      const geometry = a === 0 && b === L ? f.geometry : { type: "LineString", coordinates: lineSlice(coords, a, b) };
      if (geometry.coordinates.length < 2) continue;
      let ids = f.properties.curb_policy_ids || [];
      if (win) {
        ids = win.rules.map((rule, n) => {
          const id = `community-${win.id.slice(0, 8)}-${n}`;
          policies[id] ||= { ...rule, curb_policy_id: id, source: "community", submission_id: win.id, reviewed_at: win.reviewed_at };
          return id;
        });
      }
      out.push({ ...f, geometry, properties: { ...f.properties, curb_policy_ids: ids, _from: +a.toFixed(1), _to: +b.toFixed(1), ...(win ? { _community: win.id } : {}) } });
      stats.pieces++;
    }
  }
  stats.missing = [...byZone.keys()].filter((z) => !seen.has(z)).length; // corrections for curbs the city no longer lists
  if (accepted.length) log(`  community: ${stats.corrections} accepted corrections on ${stats.curbs} curbs → ${stats.pieces} pieces (${stats.redrawn} curbs redrawn by the city since, ${stats.missing} curbs no longer in the feed)`);
  return { features: out, stats };
}
