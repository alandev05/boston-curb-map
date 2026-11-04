// Geometry of a curb as drawn on the map (tile geometry), shared by the correction editor and the moderator panel.
// Tile pieces of one curb, joined end to end (a curb can cross a tile edge).
export function chain(parts) {
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
