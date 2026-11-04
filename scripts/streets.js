// The street list the search box completes from, letter by letter, without a round trip: every named street with
// curbs on the map, one entry per stretch of that name (Boston has a Washington Street in several neighborhoods),
// labeled with the neighborhood it's in. Written to public/data/streets.json as [name, neighborhood, w, s, e, n, anchors]
// (anchors: flat [lng, lat, …] every ~250 m along a long street, else empty).
import { projector } from "./snap.js";

const P = projector(42.35);

// names: [{ name, coords }] (OSM street-name lines); places: [{ name, cls, coord }] (OSM place labels);
// curbs: features as drawn. A name's lines within `join` m of each other are one street.
export function buildStreets(names, places, curbs, { join = 80, near = 30 } = {}) {
  // Where curbs are drawn, on a grid of `near` m cells.
  const cell = (x, y) => `${Math.floor(x / near)},${Math.floor(y / near)}`, curbCells = new Set();
  for (const f of curbs) {
    if (!f.geometry) continue;
    const g = f.geometry, lines = g.type === "MultiLineString" ? g.coordinates : g.type === "LineString" ? [g.coordinates] : [];
    for (const l of lines) for (const p of sample(l.map(P.fwd), near / 2)) curbCells.add(cell(...p));
  }
  const byName = new Map();
  for (const n of names) (byName.get(n.name) || byName.set(n.name, []).get(n.name)).push(n.coords.map(P.fwd));
  // Neighborhood labels: the nearest suburb (Back Bay, Dorchester) to each point along the street. A street mostly in
  // one is labeled with it, one split between two with both, a long one through many just "Boston".
  const suburbs = places.filter((p) => p.cls === "suburb"), hoods = (suburbs.length ? suburbs : places).map((p) => ({ ...p, xy: P.fwd(p.coord) }));
  const nearestHood = ([x, y]) => {
    let best = null;
    for (const h of hoods) { const d = Math.hypot(h.xy[0] - x, h.xy[1] - y); if (!best || d < best.d) best = { d, name: h.name }; }
    return best?.name || "";
  };
  const labelOf = (pts) => {
    const count = new Map();
    for (const p of pts) { const h = nearestHood(p); count.set(h, (count.get(h) || 0) + 1); }
    const top = [...count].sort((a, b) => b[1] - a[1]), share = (k) => top.slice(0, k).reduce((n, [, c]) => n + c, 0) / pts.length;
    return share(1) >= 0.6 ? top[0][0] : top.length > 1 && share(2) >= 0.75 ? `${top[0][0]} – ${top[1][0]}` : "Boston";
  };
  const out = [];
  for (const [name, lines] of byName) {
    // Union the name's lines where one's end comes within `join` m of the other (tiles overlap, so a street cut by a
    // tile edge continues past the end of its piece in the next tile rather than meeting it end to end).
    const parent = lines.map((_, i) => i), find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const touches = (a, b) => [a[0], a.at(-1)].some((p) => distTo(p, b) <= join) || [b[0], b.at(-1)].some((p) => distTo(p, a) <= join);
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) if (find(i) !== find(j) && touches(lines[i], lines[j])) parent[find(i)] = find(j);
    const groups = new Map();
    lines.forEach((l, i) => (groups.get(find(i)) || groups.set(find(i), []).get(find(i))).push(l));
    for (const group of groups.values()) {
      const pts = group.flatMap((l) => sample(l, near / 2));
      if (!pts.some((p) => curbCells.has(cell(...p)))) continue; // not a street with curbs on the map
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const [w, s] = P.inv([Math.min(...xs), Math.min(...ys)]), [e, n] = P.inv([Math.max(...xs), Math.max(...ys)]);
      // A few points along a long street, so picking it can go to the stretch nearest the map rather than fit it all.
      const anchors = [];
      for (const p of group.flatMap((l) => sample(l, 250))) if (anchors.every((a) => Math.hypot(a[0] - p[0], a[1] - p[1]) > 200)) anchors.push(p);
      const along = group.flatMap((l) => sample(l, 50));
      out.push([name, labelOf(along), ...[w, s, e, n].map((v) => +v.toFixed(5)), anchors.length > 2 ? anchors.flatMap((a) => P.inv(a).map((v) => +v.toFixed(4))) : []]);
    }
  }
  // Stretches with the same name and neighborhood are one result (the box around both).
  const merged = new Map();
  for (const r of out) {
    const k = `${r[0]}|${r[1]}`, m = merged.get(k);
    if (!m) merged.set(k, r);
    else merged.set(k, [r[0], r[1], Math.min(m[2], r[2]), Math.min(m[3], r[3]), Math.max(m[4], r[4]), Math.max(m[5], r[5]), [...m[6], ...r[6]]]);
  }
  return [...merged.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

function distTo([x, y], line) {
  let best = Infinity;
  for (let k = 1; k < line.length; k++) {
    const [ax, ay] = line[k - 1], dx = line[k][0] - ax, dy = line[k][1] - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}
// Points every `step` m along a line (meters coords), ends included.
function sample(line, step) {
  const out = [line[0]];
  for (let k = 1; k < line.length; k++) {
    const [ax, ay] = line[k - 1], [bx, by] = line[k], L = Math.hypot(bx - ax, by - ay);
    for (let d = step; d < L; d += step) out.push([ax + ((bx - ax) * d) / L, ay + ((by - ay) * d) / L]);
    out.push(line[k]);
  }
  return out;
}
