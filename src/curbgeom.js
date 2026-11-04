// Geometry of a curb as drawn on the map (tile geometry), shared by the correction editor and the moderator panel.
// Tile pieces of one curb, joined end to end (a curb can cross a tile edge), keeping the first piece's direction (the
// curb's side is drawn with line-offset, which follows the line's direction). Takes the pieces it joins out of `parts`.
// Tiles carry a buffer, so pieces from neighbouring tiles overlap by a few meters rather than meeting at a point:
// a piece whose end lies along another continues it, and one lying entirely along another is a copy and is dropped.
export function chain(parts) {
  if (!parts.length) return [];
  let line = [...parts.shift()];
  for (let i = 0; i < parts.length; ) {
    const joined = join(line, parts[i]);
    if (joined) { line = joined; parts.splice(i, 1); i = 0; } else i++;
  }
  return line;
}
const TOL = 1.5e-5; // ~1.2 m: tile coordinates are rounded, so copies of one line don't match exactly
// Where along `line` `pt` lies (within TOL), as segment index + fraction of it, or -1.
function along(pt, line) {
  for (let k = 1; k < line.length; k++) {
    const [ax, ay] = line[k - 1], dx = line[k][0] - ax, dy = (line[k][1] - ay) * 1.35, px = pt[0] - ax, py = (pt[1] - ay) * 1.35;
    const u = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(px - u * dx, py - u * dy) < TOL) return k - 1 + Math.min(u, 0.999);
  }
  return -1;
}
function join(a, b) {
  for (const q of [b, [...b].reverse()]) {
    if (along(q[0], a) >= 0 && along(q.at(-1), a) >= 0) return a; // a copy of part of a
    if (along(a[0], q) >= 0 && along(a.at(-1), q) >= 0 && along(a[0], q) <= along(a.at(-1), q)) return [...q];
    for (const [x, y] of [[a, q], [q, a]]) {
      const i = along(y[0], x); // x runs into y: keep x up to where y begins, then all of y
      if (i >= 0 && along(x.at(-1), y) >= 0) return [...x.slice(0, Math.floor(i) + 1), ...y];
    }
  }
  return null;
}
export function slice(line, a, b) {
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

// The drawn line of each rendered piece of the given feature ids: { id → [[lng, lat], …] } (pieces joined per id).
export function renderedLines(map, ids, layers = ["zone-line"]) {
  const want = new Set(ids), parts = new Map();
  for (const f of map.queryRenderedFeatures({ layers })) {
    if (!want.has(f.id)) continue;
    const list = parts.get(f.id) || parts.set(f.id, { props: f.properties, lines: [] }).get(f.id);
    list.lines.push(...(f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates]));
  }
  return new Map([...parts].map(([id, { props, lines }]) => [id, { props, line: chain(lines) }]));
}
