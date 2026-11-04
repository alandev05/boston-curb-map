// Join the city's street-sweeping table (no geometry) onto curbs.
// Each row names a street, a side (odd/even house numbers), the stretch between two cross streets, and when it's
// swept. Matching uses the basemap's own OSM data:
//   street     each drawn curb takes the name of the OSM street it runs along
//   stretch    the row's two cross streets are located where their OSM lines meet the street; when names repeat
//              (Washington St crosses half the city) the pair whose distance best fits the row's `miles` wins.
//              "Dead End" is the street's end at about that distance; "Dead End" at both ends is the whole street;
//              the same cross street at both ends with one junction is a loop off it. A cross street whose line stops
//              just short of this one (a T across a wide road) gets a second, looser look.
//   side       a curb's odd/even side comes from house numbers on its side of the street: the City's address list
//              (only addresses on this street) and OSM's, spread to neighbors and the facing curb where unknown
// Curbs whose own curb-feed rules already include street cleaning are left alone (the feed is newer and per-curb).
// Each row becomes a policy: no parking for street cleaning on the listed days/weeks/hours, April–November
// unless the row is marked year-round.
import { projector } from "./snap.js";
import { isStreetCleaning as isStreetCleaningPolicy, overriddenBy } from "../src/rules.js";

// RFC-4180-ish: quoted fields with "" escapes (the table has names like "Anthony ""Rip"" Valenti Way").
export function parseCsv(text) {
  const rows = [];
  let field = "", row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(field); field = ""; if (row.length > 1 || row[0]) rows.push(row); row = []; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] ?? ""])));
}

// "Mt Vernon St" and OSM's "Mount Vernon Street" → "mount vernon street".
const ABBR = { st: "street", ave: "avenue", av: "avenue", rd: "road", pl: "place", sq: "square", ter: "terrace", terr: "terrace", ct: "court", pkwy: "parkway", pky: "parkway", blvd: "boulevard", dr: "drive", ln: "lane", hwy: "highway", wy: "way", pk: "park", cir: "circle", cr: "circle", ext: "extension", mt: "mount", ft: "fort", sq_: "square", n: "north", s: "south", e: "east", w: "west" };
// A leading "St" is Saint ("St Botolph St" → "saint botolph street").
export const normName = (s) => String(s || "").toLowerCase().replace(/["'.]/g, "").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean)
  .map((w, i, all) => (i === 0 && w === "st" && all.length > 1 ? "saint" : ABBR[w] || w)).join(" ");
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

const DAY_COLS = [["sunday", "sun"], ["monday", "mon"], ["tuesday", "tue"], ["wednesday", "wed"], ["thursday", "thu"], ["friday", "fri"], ["saturday", "sat"]];
const yes = (v) => v === "t" || v === "true" || v === "1";
export function rowPolicy(r) {
  const days = yes(r.every_day) ? DAY_COLS.map(([, d]) => d) : DAY_COLS.filter(([c]) => yes(r[c])).map(([, d]) => d);
  const weeks = [1, 2, 3, 4, 5].filter((w) => yes(r[`week_${w}`]));
  return {
    curb_policy_id: `sweep-${r.main_id}`, priority: 2, description: `* Street Cleaning ${r.from || ""}–${r.to || ""}`.trim(),
    rules: [{ activity: "no parking", purposes: ["street_cleaning"] }],
    time_spans: [{
      days_of_week: days, time_of_day_start: r.start_time || null, time_of_day_end: r.end_time || null,
      weeks_of_month: weeks.length && weeks.length < 5 ? weeks : null,
      months: yes(r.year_round) ? null : [4, 5, 6, 7, 8, 9, 10, 11], // April 1 – November 30
    }],
  };
}

const P = projector(42.35);
const segIndex = (cell) => {
  const grid = new Map(), key = (i, j) => i * 100003 + j;
  return {
    add(s) {
      for (let i = Math.floor(Math.min(s.ax, s.bx) / cell); i <= Math.floor(Math.max(s.ax, s.bx) / cell); i++)
        for (let j = Math.floor(Math.min(s.ay, s.by) / cell); j <= Math.floor(Math.max(s.ay, s.by) / cell); j++) { const k = key(i, j); (grid.get(k) || grid.set(k, []).get(k)).push(s); }
    },
    near([x, y], r = 1) {
      const out = new Set(), i0 = Math.floor(x / cell), j0 = Math.floor(y / cell);
      for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) for (const s of grid.get(key(i, j)) || []) out.add(s);
      return out;
    },
  };
};
const closestOnSeg = (p, s) => {
  const dx = s.bx - s.ax, dy = s.by - s.ay, t = Math.max(0, Math.min(1, ((p[0] - s.ax) * dx + (p[1] - s.ay) * dy) / (dx * dx + dy * dy || 1)));
  return [s.ax + t * dx, s.ay + t * dy];
};
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// Where two segments meet: their crossing point if they cross, else their closest approach.
function segMeet(s, t) {
  const rx = s.bx - s.ax, ry = s.by - s.ay, qx = t.bx - t.ax, qy = t.by - t.ay, den = rx * qy - ry * qx;
  if (Math.abs(den) > 1e-9) {
    const u = ((t.ax - s.ax) * qy - (t.ay - s.ay) * qx) / den, v = ((t.ax - s.ax) * ry - (t.ay - s.ay) * rx) / den;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return { d: 0, at: [s.ax + u * rx, s.ay + u * ry] };
  }
  let best = null;
  for (const [p, seg] of [[[s.ax, s.ay], t], [[s.bx, s.by], t], [[t.ax, t.ay], s], [[t.bx, t.by], s]]) {
    const q = closestOnSeg(p, seg), d = d2(p, q);
    if (!best || d < best.d) best = { d, at: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] };
  }
  return best;
}

export function assignSweeping(features, policies, rows, osm, { log = () => {} } = {}) {
  const stats = { rows: rows.length, rowsMatched: 0, curbsSwept: 0, skipped: { noStreet: 0, noCrossStreets: 0, noCurbs: 0 }, noCurbsWhy: { nothingInStretch: 0, otherSide: 0, alreadyInFeed: 0 }, curbParity: { odd: 0, even: 0, unknown: 0 }, keptCurbFeedCleaning: 0, overridden: 0 };
  // Named street segments, by name and spatially.
  const byName = new Map(), named = segIndex(40);
  for (const { name, coords } of osm.names || []) {
    const n = normName(name), pts = coords.map(P.fwd);
    for (let k = 1; k < pts.length; k++) {
      const s = { name: n, ax: pts[k - 1][0], ay: pts[k - 1][1], bx: pts[k][0], by: pts[k][1] };
      const L = Math.hypot(s.bx - s.ax, s.by - s.ay); if (L < 0.5) continue;
      s.ux = (s.bx - s.ax) / L; s.uy = (s.by - s.ay) / L;
      (byName.get(n) || byName.set(n, []).get(n)).push(s); named.add(s);
    }
  }
  // SWEEP_HOLDOUT=1: hide a fifth of the sides known from house numbers and report how many the spreading below gets
  // right (a check on the guesses, not used for the map).
  let seed = 7;
  const holdout = process.env.SWEEP_HOLDOUT ? { n: 0, right: 0, wrong: 0, pick: () => ((seed = (seed * 16807) % 2147483647) / 2147483647) < 0.2 } : null;
  const nums = new Map(), NC = 40;
  // House numbers: OpenStreetMap's (no street name), and the City's address list (each with its street, so a corner
  // building's number on the cross street isn't counted for this one).
  const addNum = (num, coord, street) => { const p = P.fwd(coord), k = `${Math.floor(p[0] / NC)},${Math.floor(p[1] / NC)}`; (nums.get(k) || nums.set(k, []).get(k)).push({ num, p, street }); };
  for (const { num, coord } of osm.numbers || []) addNum(num, coord, null);
  for (const [lng, lat, num, street] of osm.addresses || []) addNum(num, [lng, lat], normName(street));

  // Each drawn curb: the street it's on, a point on that street's centerline, which way its side faces, its parity.
  const curbsByName = new Map();
  features.forEach((f, i) => {
    if (!f.geometry || !/LineString/.test(f.geometry.type)) return;
    const part = f.geometry.type === "MultiLineString" ? f.geometry.coordinates.reduce((a, b) => (b.length > a.length ? b : a)) : f.geometry.coordinates;
    const c = part.map(P.fwd), mid = c[Math.floor(c.length / 2)], prev = c[Math.max(0, Math.floor(c.length / 2) - 1)], next = c[Math.min(c.length - 1, Math.floor(c.length / 2) + 1)];
    const L = d2(prev, next) || 1, hx = (next[0] - prev[0]) / L, hy = (next[1] - prev[1]) / L;
    const snapped = !!f.properties._side;
    let best = null;
    for (const s of named.near(mid)) {
      if (Math.abs(hx * s.ux + hy * s.uy) < 0.8) continue;
      const q = closestOnSeg(mid, s), d = d2(mid, q);
      if (d <= (snapped ? 8 : 16) && (!best || d < best.d)) best = { d, q, s };
    }
    if (!best) return;
    // Unit vector from the street's centerline toward this curb.
    let nx, ny;
    if (snapped) { nx = f.properties._side * hy; ny = -f.properties._side * hx; }
    else { const L2 = d2(mid, best.q) || 1; nx = (mid[0] - best.q[0]) / L2; ny = (mid[1] - best.q[1]) / L2; }
    const center = snapped ? mid : best.q, half = d2(c[0], c.at(-1)) / 2 + 15;
    let odd = 0, even = 0;
    const gx = Math.floor(center[0] / NC), gy = Math.floor(center[1] / NC);
    for (let a = gx - 2; a <= gx + 2; a++) for (let b = gy - 2; b <= gy + 2; b++) for (const h of nums.get(`${a},${b}`) || []) {
      const vx = h.p[0] - center[0], vy = h.p[1] - center[1], along = vx * best.s.ux + vy * best.s.uy, lat = vx * nx + vy * ny;
      if (h.street && h.street !== best.s.name) continue;
      if (Math.abs(along) <= half && lat >= 3 && lat <= 45) h.num % 2 ? odd++ : even++;
    }
    let parity = odd + even && Math.max(odd, even) / (odd + even) >= 0.7 ? (odd > even ? "odd" : "even") : null;
    const rec = { i, center, parity, nx, ny };
    if (holdout && parity && holdout.pick()) { rec.truth = parity; rec.parity = null; } // SWEEP_HOLDOUT: hide some known sides to measure the guesses
    (curbsByName.get(best.s.name) || curbsByName.set(best.s.name, []).get(best.s.name)).push(rec);
  });
  // OSM house numbers are sparse, so spread what's known: the curb facing a known side has the other parity, and
  // a side's parity carries along to its neighbors on the same side of the same street.
  const other = { odd: "even", even: "odd" };
  for (const list of curbsByName.values()) {
    for (let round = 0; round < 6; round++) {
      let changed = 0;
      for (const a of list) {
        if (a.parity) continue;
        let best = null;
        for (const b of list) {
          if (!b.parity || b === a) continue;
          const d = d2(a.center, b.center), facing = a.nx * b.nx + a.ny * b.ny;
          if (facing < -0.5 && d < 30 && (!best || d < best.d)) best = { d, p: other[b.parity] };
          else if (facing > 0.5 && d < 60 && (!best || d < best.d)) best = { d, p: b.parity };
        }
        if (best) { a.parity = best.p; changed++; }
      }
      if (!changed) break;
    }
    for (const a of list) {
      stats.curbParity[a.parity || "unknown"]++;
      if (a.truth) { holdout.n++; if (a.parity === a.truth) holdout.right++; else if (a.parity) holdout.wrong++; }
    }
  }

  // Rows for the same stretch on both sides with the same schedule don't need the side resolved.
  const sched = (r) => ["start_time", "end_time", "week_1", "week_2", "week_3", "week_4", "week_5", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "every_day", "year_round"].map((k) => r[k]).join("|");
  const stretch = (r) => [normName(r.st_name), normName(r.from), normName(r.to)].join("|");
  const sidesAgree = new Map();
  for (const r of rows) { const k = stretch(r), v = sidesAgree.get(k); sidesAgree.set(k, v === undefined ? sched(r) : v === sched(r) ? v : false); }

  // Where the cross street meets this one. A cross street whose line stops just short (a T across a wide road, a
  // slightly misdrawn junction) gets a second, looser look.
  const meetsWithin = (street, cross, tol) => {
    const out = [];
    for (const s of street) for (const t of cross) { const m = segMeet(s, t); if (m.d < tol && !out.some((o) => d2(o, m.at) < 30)) out.push(m.at); }
    return out;
  };
  const meets = (street, cross) => { const m = meetsWithin(street, cross, 15); return m.length ? m : meetsWithin(street, cross, 35); };
  // "Dead End", or the city line ("Brookline Town Line"): the street simply ends within Boston.
  const deadEnd = (n) => !n || /dead\s*end|^end$|town\s*line|city\s*line/i.test(n);
  // The cross street's segments: by exact name, else among streets that actually meet this one, the closest name
  // (typos like "Cheslea St", or a bare "Mount Vernon").
  const crossing = new Map();
  const crossSegs = (streetName, street, crossName) => {
    const n = normName(crossName);
    if (byName.has(n)) return byName.get(n);
    if (!crossing.has(streetName)) {
      const met = new Set();
      for (const s of street) for (const t of named.near([(s.ax + s.bx) / 2, (s.ay + s.by) / 2])) if (t.name !== streetName && segMeet(s, t).d < 15) met.add(t.name);
      crossing.set(streetName, [...met]);
    }
    let best = null;
    for (const m of crossing.get(streetName)) {
      const score = m.startsWith(n + " ") ? 0 : lev(n, m);
      if (score <= 2 && (!best || score < best.score)) best = { score, m };
    }
    return best ? byName.get(best.m) : [];
  };

  for (const r of rows) {
    const name = normName(r.st_name), street = byName.get(name), curbs = curbsByName.get(name);
    if (!street || !curbs) { stats.skipped.noStreet++; continue; }
    const target = (+r.miles || 0) * 1609.34;
    let A = deadEnd(r.from) ? null : meets(street, crossSegs(name, street, r.from));
    let B = deadEnd(r.to) ? null : meets(street, crossSegs(name, street, r.to));
    // "Tremont St to Tremont St" with a single junction: a loop or cul-de-sac off it, so the far end is the street's end.
    if (A?.length === 1 && B?.length === 1 && normName(r.from) === normName(r.to)) B = null;
    let p1 = null, p2 = null;
    if (A === null && B === null) {
      // "Dead End to Dead End": the whole street (its two farthest-apart ends).
      const ends = street.flatMap((s) => [[s.ax, s.ay], [s.bx, s.by]]);
      let best = -1;
      for (const a of ends) for (const b of ends) { const d = d2(a, b); if (d > best) { best = d; p1 = a; p2 = b; } }
      if (target && Math.abs(best - target) > Math.max(80, target * 0.5)) p1 = p2 = null; // not this street, or not all of it
    }
    if (A?.length && B?.length) {
      let best = Infinity;
      for (const a of A) for (const b of B) {
        const d = d2(a, b); if (d < 10) continue;
        const score = target ? Math.abs(d - target) : d;
        if (score < best) { best = score; p1 = a; p2 = b; }
      }
      if (p1 && target && Math.abs(d2(p1, p2) - target) > Math.max(80, target * 0.5)) p1 = p2 = null;
    } else if ((A?.length || B?.length) && target && (A === null || B === null)) {
      // One end is a dead end: the street's far end at about the row's length from the known intersection.
      const known = (A?.length ? A : B), ends = street.flatMap((s) => [[s.ax, s.ay], [s.bx, s.by]]);
      let best = Infinity;
      for (const k of known) for (const e of ends) { const d = d2(k, e); if (d < 20 || d > target * 1.4) continue; const sc = Math.abs(d - target); if (sc < best) { best = sc; p1 = k; p2 = e; } }
    }
    if (!p1) { stats.skipped.noCrossStreets++; continue; }
    const span = d2(p1, p2), slack = Math.max(25, span * 0.08);
    const side = /odd/i.test(r.side) ? "odd" : /even/i.test(r.side) ? "even" : null;
    const policy = rowPolicy(r);
    let attached = 0, overridden = 0, inStretch = 0, otherSide = 0, inFeed = 0;
    for (const c of curbs) {
      if (d2(c.center, p1) + d2(c.center, p2) > span + slack) continue;
      inStretch++;
      if (side && c.parity !== side && !(c.parity === null && sidesAgree.get(stretch(r)))) { otherSide++; continue; }
      const f = features[c.i], ids = f.properties.curb_policy_ids || [];
      if (ids.includes(policy.curb_policy_id)) continue;
      if (ids.some((id) => policies[id] && !String(id).startsWith("sweep-") && isStreetCleaningPolicy(policies[id]))) { stats.keptCurbFeedCleaning++; inFeed++; continue; }
      // Cleaning can't apply where an always-on rule of higher precedence (a hydrant's "no stopping") already holds.
      if (overriddenBy(policy, ids.map((id) => policies[id]).filter(Boolean))) { stats.overridden++; overridden++; continue; }
      f.properties = { ...f.properties, curb_policy_ids: [...ids, policy.curb_policy_id] };
      attached++;
    }
    if (!attached) {
      if (!overridden) { stats.skipped.noCurbs++; stats.noCurbsWhy[!inStretch ? "nothingInStretch" : inFeed ? "alreadyInFeed" : otherSide === inStretch ? "otherSide" : "nothingInStretch"]++; }
      continue;
    }
    policies[policy.curb_policy_id] = policy;
    stats.rowsMatched++; stats.curbsSwept += attached;
  }
  if (holdout) log(`  sweeping side guesses on held-out curbs: ${holdout.right} right, ${holdout.wrong} wrong, ${holdout.n - holdout.right - holdout.wrong} still unknown`);
  log(`  street sweeping: ${stats.rowsMatched}/${stats.rows} rows matched → ${stats.curbsSwept} curb assignments; skipped ${JSON.stringify(stats.skipped)} (no curbs: ${JSON.stringify(stats.noCurbsWhy)}); curb sides odd/even/unknown ${stats.curbParity.odd}/${stats.curbParity.even}/${stats.curbParity.unknown}; kept curb-feed cleaning on ${stats.keptCurbFeedCleaning}; left off ${stats.overridden} where an always-on rule overrides it`);
  return stats;
}
