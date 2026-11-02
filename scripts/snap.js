// Conflate curb zones onto the basemap's road centerlines, like a traffic layer.
// The city's curb geometry sits on the physical curb (4–6 m off the centerline), but the basemap draws
// roads at a symbolic pixel width, so raw curbs float off the road at most zooms. Instead each curb is
// projected onto the OSM centerline it runs along and tagged with the side it's on (+1 right / -1 left of
// its own direction) and the road class; the map then pushes it to that edge of the drawn road with
// `line-offset`, which lines up at every zoom.

import { ROADS } from "../src/basemap.js";

const R = 6371008.8;
const halfWidth = (cls) => (ROADS[cls] || ROADS.minor).m / 2;

// Local equirectangular projection in meters — plenty accurate across one city.
export function projector(lat0) {
  const kx = (Math.PI / 180) * R * Math.cos((lat0 * Math.PI) / 180), ky = (Math.PI / 180) * R;
  return { fwd: ([lon, lat]) => [lon * kx, lat * ky], inv: ([x, y]) => [x / kx, y / ky] };
}

function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

// Douglas–Peucker, so the snapped line keeps only the vertices that carry shape.
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], L = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1, wd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Drop short hooks at either end of a run (and short interior doubling-back): the last few meters of a curb often project onto a corner node and
// double back, which line-offset turns into a visible spike.
function trimHooks(r, maxHook = 8, cosLimit = 0.5) {
  const turn = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    return (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
  };
  const seg = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  while (r.length >= 3 && seg(r[0], r[1]) < maxHook && turn(r[0], r[1], r[2]) < cosLimit) r = r.slice(1);
  while (r.length >= 3 && seg(r[r.length - 2], r[r.length - 1]) < maxHook && turn(r[r.length - 3], r[r.length - 2], r[r.length - 1]) < cosLimit) r = r.slice(0, -1);
  // Interior doubling-back over a few meters (a projection that briefly hopped and returned): drop the vertex.
  for (let i = 1; i < r.length - 1; ) {
    if (turn(r[i - 1], r[i], r[i + 1]) < cosLimit && Math.min(seg(r[i - 1], r[i]), seg(r[i], r[i + 1])) < maxHook) r = [...r.slice(0, i), ...r.slice(i + 1)];
    else i++;
  }
  return r;
}

// Shorten a run end by `d` meters along the run (from the start if atStart, else from the end).
function cutEnd(r, d, atStart) {
  const pts = atStart ? r.slice().reverse() : r.slice();
  let left = d;
  while (pts.length >= 2 && left > 0) {
    const a = pts[pts.length - 2], b = pts[pts.length - 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L <= left) { pts.pop(); left -= L; continue; }
    const k = (L - left) / L; pts[pts.length - 1] = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]; left = 0;
  }
  return atStart ? pts.reverse() : pts;
}

// Stop curb ends short of cross streets, like Google's traffic lines. Each end is checked where it is actually
// drawn (pushed `side` × half the road width off the centerline). Any cross street whose centerline passes beside
// that point, closer than its own half-width + `setback`, would put this line across the other street's curb,
// so the end is trimmed back until it clears. Only cross streets running past the drawn point count (the foot of
// the perpendicular must land on the segment), so a T-junction on the far side of the road doesn't trim this side.
export function trimAtCrossings(r, side, rc, index, { setback = 1.5, maxTrim = 12, crossCos = 0.5 } = {}) {
  const off = halfWidth(rc);
  for (const atStart of [true, false]) {
    for (let guard = 0; guard < 30 && r.length >= 2; guard++) {
      const [a, b] = atStart ? [r[1], r[0]] : [r[r.length - 2], r[r.length - 1]]; // b = the end, a→b points outward
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const fx = (b[0] - a[0]) / L, fy = (b[1] - a[1]) / L;
      // Right of the run's own direction is (fy, -fx) at the end; at the start the run's direction is reversed.
      const s = atStart ? -side : side;
      const px = b[0] + s * off * fy, py = b[1] - s * off * fx;
      let need = 0;
      for (const seg of index.near([px, py])) {
        if (Math.abs(fx * seg.ux + fy * seg.uy) > crossCos) continue; // only roads crossing this one
        const t = ((px - seg.ax) * seg.dx + (py - seg.ay) * seg.dy) / (seg.L * seg.L);
        if (t < 0 || t > 1) continue;
        const d = Math.hypot(px - (seg.ax + t * seg.dx), py - (seg.ay + t * seg.dy));
        need = Math.max(need, halfWidth(seg.cls) + setback - d);
      }
      if (need <= 0.05) break;
      r = cutEnd(r, Math.min(need, 2), atStart);
      if (lengthOf(r) < 1) return [];
    }
  }
  return r;
}

const lengthOf = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

// roads: [{ coords: [[lon,lat],...], cls }] — OSM transportation lines (OpenMapTiles classes).
export function makeRoadIndex(roads, proj, cell = 40) {
  const grid = new Map(), segs = [];
  const key = (i, j) => i * 100003 + j;
  roads.forEach((r, rid) => {
    const pts = r.coords.map(proj.fwd);
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1], [bx, by] = pts[k];
      const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
      if (L < 0.01) continue;
      const s = { ax, ay, dx, dy, L, ux: dx / L, uy: dy / L, rid, cls: r.cls };
      const id = segs.push(s) - 1;
      for (let i = Math.floor(Math.min(ax, bx) / cell); i <= Math.floor(Math.max(ax, bx) / cell); i++)
        for (let j = Math.floor(Math.min(ay, by) / cell); j <= Math.floor(Math.max(ay, by) / cell); j++) {
          const kk = key(i, j); (grid.get(kk) || grid.set(kk, []).get(kk)).push(id);
        }
    }
  });
  return {
    near([x, y]) {
      const i0 = Math.floor(x / cell), j0 = Math.floor(y / cell), seen = new Set(), out = [];
      for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++)
        for (const id of grid.get(key(i, j)) || []) if (!seen.has(id)) { seen.add(id); out.push(segs[id]); }
      return out;
    },
  };
}

// Snap one LineString (lon/lat coords). Returns { coords, multi, side, rc } or null when it doesn't follow a road.
// A curb that wraps a corner matches one road and then another. Joining those projections would draw a spike
// across the intersection, so the snapped points are split into runs wherever the matched road's direction
// turns sharply or the projection jumps, and each run is kept on its own street (a MultiLineString).
// The side doesn't change between runs: walking along a curb, the road stays on the same side around a corner.
// A curb with parallel roads on BOTH sides (a median between carriageways, the gore of a fork or slip lane) can't be
// snapped meaningfully: the drawn carriageways overlap there and any choice of line is a guess. Those points count
// as unmatched; a curb that's mostly between roads keeps its true geometry, which lies inside the drawn road surface.
// Except when the two drawn surfaces merge into one wide road (a divided avenue whose carriageways OSM puts ~12 m
// apart, e.g. Mass Ave in Back Bay; drawn edges ≤ MERGE_GAP apart): there's no visible median, so the curb goes on the outer edge of the nearer
// carriageway — the edge its neighbors are drawn on — instead of wobbling at its raw position inside the road.
// onlyClass / keepRatio: used when following a snapped neighbor — only that road class counts, and a smaller matched
// share is enough because the neighbor already settled which road and side this curb belongs to.
// Two parallel roads whose drawn edges are at most this far apart read as one road (no visible median between).
export const MERGE_GAP = 5;
export function snapLine(coords, index, proj, { maxDist = 14, minCos = 0.85, step = 4, turnCos = 0.75, between = 12, trim = {}, onlyClass = null, keepRatio = 0.5 } = {}) {
  const trimOpts = trim;
  const raw = coords.map(proj.fwd);
  const len = lengthOf(raw);
  if (raw.length < 2 || len < 0.5) return { fail: "degenerate" };
  const pts = densify(raw, step);
  const hits = [], cls = {};
  let vote = 0, prevRid = -1, betweenRoads = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let hx = b[0] - a[0], hy = b[1] - a[1];
    const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
    const [px, py] = pts[i];
    let best = null, nearLeft = Infinity, nearRight = Infinity, segLeft = null, segRight = null;
    for (const s of index.near(pts[i])) {
      if (onlyClass && s.cls !== onlyClass) continue;
      const cos = hx * s.ux + hy * s.uy;
      if (Math.abs(cos) < minCos) continue; // cross streets at corners
      const tRaw = ((px - s.ax) * s.dx + (py - s.ay) * s.dy) / (s.L * s.L);
      const t = Math.max(0, Math.min(1, tRaw));
      const qx = s.ax + t * s.dx, qy = s.ay + t * s.dy;
      const d = Math.hypot(px - qx, py - qy);
      if (tRaw > 0 && tRaw < 1) { // which side of the curb this road runs on (ignoring roads that merely end nearby)
        if ((qx - px) * hy - (qy - py) * hx > 0) { if (d < nearRight) { nearRight = d; segRight = { s, qx, qy }; } }
        else if (d < nearLeft) { nearLeft = d; segLeft = { s, qx, qy }; }
      }
      // Stay on the same road through a zone. Moving onto the next way of the same street happens at a shared node
      // (no sideways step) and is cheap; hopping sideways to a parallel road (service road, other carriageway)
      // costs 3× the step, which stops the projection zigzagging between the two.
      const last = hits[hits.length - 1]?.p ? hits[hits.length - 1] : null;
      const lateral = last && s.rid !== prevRid ? Math.abs((qx - last.p[0]) * last.uy - (qy - last.p[1]) * last.ux) : 0;
      const score = d + (s.rid === prevRid ? 0 : 1.5 + 3 * lateral);
      if (d <= maxDist && (!best || score < best.score)) best = { score, qx, qy, s };
    }
    if (nearLeft < between && nearRight < between) {
      // Carriageways of one divided street share a class; a boulevard beside a motorway, or a street beside a
      // service road, is two roads even when they're drawn touching.
      if (segLeft.s.cls === segRight.s.cls && nearLeft + nearRight <= 2 * halfWidth(segLeft.s.cls) + MERGE_GAP) {
        // One wide road. Which carriageway is decided after the walk, once per unbroken stretch of such points
        // (the nearer one on average), so a curb near the middle doesn't zigzag between the two.
        hits.push({ merged: { L: segLeft, R: segRight }, bias: nearLeft - nearRight, hx, hy });
        prevRid = -1;
        continue;
      }
      betweenRoads++; best = null;
    }
    if (!best) { hits.push(null); prevRid = -1; continue; }
    // Road direction at the match, oriented along the curb's own direction of travel.
    const dir = Math.sign(hx * best.s.ux + hy * best.s.uy) || 1;
    hits.push({ p: [best.qx, best.qy], ux: best.s.ux * dir, uy: best.s.uy * dir });
    prevRid = best.s.rid;
    cls[best.s.cls] = (cls[best.s.cls] || 0) + 1;
    vote += Math.sign((px - best.qx) * hy - (py - best.qy) * hx); // + = curb is right of travel direction
  }
  // Merged-road points go on the outer edge of the chosen carriageway: road on the curb's right → the curb lies
  // right of it as seen along travel (+), and vice versa.
  for (let i = 0; i < hits.length; i++) {
    if (!hits[i]?.merged) continue;
    let j = i, bias = 0;
    while (j < hits.length && hits[j]?.merged) bias += hits[j++].bias;
    const side = bias >= 0 ? "R" : "L";
    for (let k = i; k < j; k++) {
      const h = hits[k], m = h.merged[side], dir = Math.sign(h.hx * m.s.ux + h.hy * m.s.uy) || 1;
      hits[k] = { p: [m.qx, m.qy], ux: m.s.ux * dir, uy: m.s.uy * dir };
      cls[m.s.cls] = (cls[m.s.cls] || 0) + 1;
      vote += side === "R" ? 1 : -1;
    }
    i = j - 1;
  }
  // Split into runs: unmatched points, a sharp change in road direction, or a jump between projections all break a run.
  const runs = [];
  let run = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i], prev = hits[i - 1];
    const breaks = !h || !prev || prev.ux * h.ux + prev.uy * h.uy < turnCos || Math.hypot(h.p[0] - prev.p[0], h.p[1] - prev.p[1]) > step * 1.5 + 1;
    if (breaks && run.length) { runs.push(run); run = []; }
    if (h) run.push(h.p);
  }
  if (run.length) runs.push(run);
  const snappedParts = runs
    .map((r) => trimHooks(simplify(r, 0.3).filter((p, i, arr) => !i || p[0] !== arr[i - 1][0] || p[1] !== arr[i - 1][1])))
    .filter((r) => r.length >= 2 && lengthOf(r) >= Math.min(3, len * 0.5));
  const kept = snappedParts.reduce((s, r) => s + lengthOf(r), 0);
  if (betweenRoads > pts.length * 0.3) return { fail: "between" }; // a median/fork curb: keep its true geometry
  if (!snappedParts.length || kept < len * keepRatio) return { fail: "unmatched" }; // mostly unmatched or collapsed onto a node
  const rc = Object.entries(cls).sort((x, y) => y[1] - x[1])[0][0];
  let side = vote >= 0 ? 1 : -1;
  // Never on the hidden inner edge of a divided road: if, drawn on this side, the curb would sit inside the other
  // carriageway's surface, it belongs on the outer edge of its own.
  if (insideTwin(snappedParts, side, rc, index) > 0.5) side = -side;
  // Trimming at cross streets can swallow a curb that lies entirely inside an intersection (a corner radius);
  // drawn anywhere, it would sit on the other street, so it isn't drawn (`parts` comes back empty).
  // Fragments under 2.5 m left after trimming read as stray dots at corners; don't draw them.
  const parts = snappedParts.map((r) => trimHooks(dedupe(trimAtCrossings(r, side, rc, index, trimOpts)))).filter((r) => r.length >= 2 && lengthOf(r) >= Math.min(2.5, len * 0.8));
  return { parts, side, rc };
}
// Share of a curb (drawn at `side`) lying inside the surface of another parallel road of the same class.
function insideTwin(parts, side, rc, index) {
  const off = halfWidth(rc) - 0.6;
  let n = 0, inside = 0;
  for (const r of parts) for (let k = 1; k < r.length; k++) {
    const [ax, ay] = r[k - 1], [bx, by] = r[k], L = Math.hypot(bx - ax, by - ay);
    if (L < 0.01) continue;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    for (let d = 0; d <= L; d += 3) {
      const cx = ax + ux * d, cy = ay + uy * d, px = cx + side * off * uy, py = cy - side * off * ux;
      n++;
      for (const sg of index.near([px, py])) {
        if (sg.cls !== rc || Math.abs(ux * sg.ux + uy * sg.uy) < 0.85) continue;
        const t = ((px - sg.ax) * sg.dx + (py - sg.ay) * sg.dy) / (sg.L * sg.L);
        if (t <= 0 || t >= 1) continue;
        const dp = Math.hypot(px - sg.ax - t * sg.dx, py - sg.ay - t * sg.dy);
        const tc = ((cx - sg.ax) * sg.dx + (cy - sg.ay) * sg.dy) / (sg.L * sg.L), dc = Math.hypot(cx - sg.ax - tc * sg.dx, cy - sg.ay - tc * sg.dy);
        if (dc > 1 && dp < halfWidth(sg.cls) - 0.5) { inside++; break; } // not the road it's on, and inside it
      }
    }
  }
  return n ? inside / n : 0;
}
const dedupe = (r) => r.filter((p, i) => i === r.length - 1 || Math.hypot(p[0] - r[i + 1][0], p[1] - r[i + 1][1]) >= 0.3);

// Last resort for a curb that won't snap but would float off the drawn roads: pull each stray vertex in to just
// inside the edge of the nearest road running the curb's way, so it's drawn on the road surface. Vertices with no such
// road within `reach` (parking lots, plazas) stay put — pulling sideways onto a cross street would distort the curb.
function clampToRoads(pts, index, { reach = 30, inset = 0.8 } = {}) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const hl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, hx = (b[0] - a[0]) / hl, hy = (b[1] - a[1]) / hl;
    let best = null;
    for (const s of index.near(p)) {
      if (Math.abs(hx * s.ux + hy * s.uy) < 0.5) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - s.ax) * s.dx + (p[1] - s.ay) * s.dy) / (s.L * s.L)));
      const qx = s.ax + t * s.dx, qy = s.ay + t * s.dy, d = Math.hypot(p[0] - qx, p[1] - qy);
      if (d <= reach && (!best || d < best.d)) best = { d, qx, qy, h: halfWidth(s.cls) };
    }
    if (!best || best.d <= best.h - inset || best.d < 0.01) return p;
    const k = (best.h - inset) / best.d;
    return [best.qx + (p[0] - best.qx) * k, best.qy + (p[1] - best.qy) * k];
  });
}

// Building footprints in meters, grid-indexed; inside(p) is a point-in-polygon test against nearby footprints.
export function makeBuildingIndex(rings, proj, cell = 50) {
  const polys = [], grid = new Map();
  for (const r of rings || []) {
    const ring = r.map(proj.fwd);
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of ring) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
    const id = polys.push({ ring, box: [a, b, c, d] }) - 1;
    for (let gx = Math.floor(a / cell); gx <= Math.floor(c / cell); gx++) for (let gy = Math.floor(b / cell); gy <= Math.floor(d / cell); gy++) {
      const k = gx * 100003 + gy; (grid.get(k) || grid.set(k, []).get(k)).push(id);
    }
  }
  return {
    size: polys.length,
    inside([x, y]) {
      for (const id of grid.get(Math.floor(x / cell) * 100003 + Math.floor(y / cell)) || []) {
        const { ring, box } = polys[id];
        if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
        let inn = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn;
        }
        if (inn) return true;
      }
      return false;
    },
  };
}
export const onSomeRoad = (p, index, tol = 1) => {
  for (const s of index.near(p)) {
    const t = Math.max(0, Math.min(1, ((p[0] - s.ax) * s.dx + (p[1] - s.ay) * s.dy) / (s.L * s.L)));
    if (Math.hypot(p[0] - s.ax - t * s.dx, p[1] - s.ay - t * s.dy) <= halfWidth(s.cls) + tol) return true;
  }
  return false;
};
// Meters of a line (meters coords) that would be drawn inside a building with no road there, sampled every 2 m.
export function metersThroughBuildings(pts, index, bidx) {
  let m = 0;
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1], [bx, by] = pts[k], L = Math.hypot(bx - ax, by - ay);
    for (let s = 0; s < L; s += 2) { const p = [ax + ((bx - ax) * s) / L, ay + ((by - ay) * s) / L]; if (bidx.inside(p) && !onSomeRoad(p, index)) m += 2; }
  }
  return m;
}

// Is a line (meters) drawn off every road — some vertex farther from the nearest centerline than that road's
// drawn half-width (+ tolerance)? Those curbs float on sidewalks/parks, so they get a second, looser snap.
function floating(pts, index, tol = 1) {
  return pts.some((p) => {
    let ok = false;
    for (const s of index.near(p)) {
      const t = Math.max(0, Math.min(1, ((p[0] - s.ax) * s.dx + (p[1] - s.ay) * s.dy) / (s.L * s.L)));
      if (Math.hypot(p[0] - s.ax - t * s.dx, p[1] - s.ay - t * s.dy) <= halfWidth(s.cls) + tol) { ok = true; break; }
    }
    return !ok;
  });
}

// Mutates nothing; returns new features.
// Every drawn curb obeys two rules, whichever way it's placed:
//   1. it sits on its own road: snapped curbs by construction; a curb left at its true position that would float off
//      every drawn road (wide street, odd OSM geometry) gets a second snap with looser limits;
//   2. it never runs onto another road: every end is trimmed back from cross streets, unsnapped curbs included,
//      and a curb that lies wholly inside an intersection isn't drawn (geometry null, so the tiler skips it).
// Curbs left unsnapped keep side 0 (no offset). `stats` counts what happened, for the build log.
export function snapZones(features, roads, opts = {}) {
  const stats = { snapped: 0, relaxed: 0, unsnapped: {}, clamped: 0, hiddenInIntersection: 0, hiddenThroughBuildings: 0 };
  if (!roads?.length) return { features, snapped: 0, stats };
  const lat0 = features.find((f) => f.geometry)?.geometry.coordinates.flat(3)[1] ?? 42.35;
  const proj = projector(lat0);
  const index = makeRoadIndex(roads, proj);
  const bidx = opts.buildings?.length ? makeBuildingIndex(opts.buildings, proj) : null;
  const lonlat = (r) => r.map((p) => proj.inv(p).map((n) => +n.toFixed(7)));
  const out = features.map((f) => {
    if (f.geometry?.type !== "LineString") return f;
    let r = snapLine(f.geometry.coordinates, index, proj, opts);
    if (r.fail && r.fail !== "degenerate" && floating(f.geometry.coordinates.map(proj.fwd), index)) {
      const loose = snapLine(f.geometry.coordinates, index, proj, { ...opts, maxDist: 25, between: 0 });
      if (!loose.fail) { r = loose; stats.relaxed++; }
    }
    if (r.fail) {
      stats.unsnapped[r.fail] = (stats.unsnapped[r.fail] || 0) + 1;
      if (r.fail === "degenerate") return f;
      let pts = f.geometry.coordinates.map(proj.fwd);
      if (floating(pts, index)) { pts = clampToRoads(pts, index); stats.clamped++; }
      const kept = trimHooks(dedupe(trimAtCrossings(pts, 0, "minor", index, opts.trim)));
      if (kept.length < 2) { stats.hiddenInIntersection++; return { ...f, geometry: null }; }
      // No road here and the line would cut through a building: the city geometry doesn't match any street on the
      // map (a private passage, a drawing error). Don't draw it rather than draw it across a block.
      if (bidx && metersThroughBuildings(kept, index, bidx) >= Math.min(6, lengthOf(kept) * 0.3)) { stats.hiddenThroughBuildings++; return { ...f, geometry: null }; }
      return { ...f, geometry: { type: "LineString", coordinates: lonlat(kept) } };
    }
    if (!r.parts.length) { stats.hiddenInIntersection++; return { ...f, geometry: null }; }
    stats.snapped++;
    return asSnapped(f, r);
  });
  followNeighbors(features, out, index, proj, opts, stats);
  return { features: out, snapped: stats.snapped, stats };

  function asSnapped(f, r) {
    const multi = r.parts.length > 1;
    return { ...f, geometry: { type: multi ? "MultiLineString" : "LineString", coordinates: multi ? r.parts.map(lonlat) : lonlat(r.parts[0]) }, properties: { ...f.properties, _side: r.side, _rc: r.rc } };
  }

  // Consecutive curbs along one side of a street should draw as one continuous line. A curb left unsnapped next to a
  // snapped one is drawn at its raw position while its neighbor sits at the road edge — a visible jog. So an unsnapped
  // curb whose raw end meets a snapped neighbor's raw end (running the same line) gets a looser snap, accepted only if
  // it lands on the same side of the road as that neighbor. Repeats so whole chains of unsnapped curbs follow along.
  function followNeighbors(raw, out, index, proj, opts, stats) {
    const cell = 10, grid = new Map(), key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    // Each end with the line's local direction there (a long curved neighbor's overall direction says little).
    const endsOf = (i) => {
      const c = raw[i].geometry.coordinates.map(proj.fwd), n = c.length;
      const dir = (a, b) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; };
      return [{ p: c[0], u: dir(c[0], c[1]), i }, { p: c[n - 1], u: dir(c[n - 2], c[n - 1]), i }];
    };
    const isLine = (i) => raw[i].geometry?.type === "LineString" && raw[i].geometry.coordinates.length >= 2;
    const addToGrid = (i) => { for (const e of endsOf(i)) { const k = key(...e.p); (grid.get(k) || grid.set(k, []).get(k)).push(e); } };
    out.forEach((f, i) => { if (f.properties?._side && isLine(i)) addToGrid(i); });
    stats.followed = 0;
    for (let round = 0; round < 4; round++) {
      let changed = 0;
      out.forEach((f, i) => {
        if (!f.geometry || f.properties?._side || !isLine(i)) return;
        let neighbor = null;
        for (const e of endsOf(i)) {
          const gx = Math.floor(e.p[0] / cell), gy = Math.floor(e.p[1] / cell);
          for (let a = gx - 1; a <= gx + 1 && !neighbor; a++) for (let b = gy - 1; b <= gy + 1 && !neighbor; b++) for (const o of grid.get(`${a},${b}`) || []) {
            if (o.i === i || Math.hypot(o.p[0] - e.p[0], o.p[1] - e.p[1]) > 6) continue;
            const cos = e.u[0] * o.u[0] + e.u[1] * o.u[1];
            if (Math.abs(cos) < 0.75) continue; // a cross street's curb (≈90°), not a continuation
            neighbor = { i: o.i, orient: Math.sign(cos) };
            break;
          }
          if (neighbor) break;
        }
        if (!neighbor) return;
        const nb = out[neighbor.i].properties;
        const r = snapLine(raw[i].geometry.coordinates, index, proj, { ...opts, maxDist: 30, between: 0, minCos: 0.5, onlyClass: nb._rc, keepRatio: 0.3 });
        if (r.fail || !r.parts.length || r.side !== nb._side * neighbor.orient || r.rc !== nb._rc) {
          // A sliver (< 4 m) that can't line up with its snapped neighbor would only draw as a stray dot beside it.
          if (lineLength(raw[i].geometry.coordinates) < 4) { out[i] = { ...f, geometry: null }; stats.hiddenInIntersection++; changed++; }
          return;
        }
        out[i] = asSnapped(f, r);
        addToGrid(i);
        stats.followed++; stats.snapped++; changed++;
      });
      if (!changed) break;
    }
  }
}

// Meters along a LineString's coordinates, or summed over a MultiLineString's parts.
export function lineLength(coords, lat0 = 42.35) {
  const fwd = projector(lat0).fwd;
  return typeof coords[0][0] === "number" ? lengthOf(coords.map(fwd)) : coords.reduce((s, part) => s + lengthOf(part.map(fwd)), 0);
}
