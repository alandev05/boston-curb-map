#!/usr/bin/env node
// Audit how curbs will be DRAWN (street-zoom geometry: snapped curbs pushed to their road edge) for visual artifacts.
//   npm run audit            # counts + a few example locations per check
//   npm run audit -- --json  # machine-readable
// Checks:
//   through-buildings  drawn inside a building where no road is drawn
//   floating           off every drawn road surface (> 0.5 m past the edge)
//   into-cross-street  a line end sitting inside a cross street's drawn surface
//   jog                consecutive curbs (one ends where the next starts) drawn > 0.8 m apart sideways
//   sharp-turn         a bend tighter than 60° inside one drawn line
//   stray              drawn > 10 m from the city's own geometry for that curb
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapZones, projector, makeRoadIndex, makeBuildingIndex, onSomeRoad } from "./snap.js";
import { loadOsm } from "./osm-roads.js";
import { ROADS } from "../src/basemap.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IN = process.env.DATA_DIR || path.join(root, "data", "raw");
const half = (c) => (ROADS[c] || ROADS.minor).m / 2;
const P = projector(42.35);

const fc = JSON.parse(await readFile(path.join(IN, "zones.geojson"), "utf8"));
const lines = fc.features.filter((f) => f.geometry);
let bb = [180, 90, -180, -90];
for (const f of lines) for (const c of f.geometry.coordinates.flat(2).reduce((a, n, i, arr) => (i % 2 ? a : [...a, [n, arr[i + 1]]]), [])) bb = [Math.min(bb[0], c[0]), Math.min(bb[1], c[1]), Math.max(bb[2], c[0]), Math.max(bb[3], c[1])];
const { roads, buildings } = await loadOsm(bb, { cacheDir: path.join(IN, "osm"), offline: true, log: () => {} });
const { features } = snapZones(fc.features, roads, { buildings });
const ridx = makeRoadIndex(roads, P), bidx = makeBuildingIndex(buildings, P);

const found = { "through-buildings": [], floating: [], "into-cross-street": [], jog: [], "sharp-turn": [], stray: [] };
const flag = (k, at, detail) => found[k].push({ at: P.inv(at).map((n) => +n.toFixed(5)), detail });
const dist = (p, c) => { let b = Infinity; for (let k = 1; k < c.length; k++) { const [ax, ay] = c[k - 1], [bx, by] = c[k], dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1))); b = Math.min(b, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy)); } return b; };
const ends = [];
features.forEach((f, i) => {
  if (!f.geometry || !/LineString/.test(f.geometry.type)) return;
  const side = f.properties._side || 0, off = side ? half(f.properties._rc) - 0.6 : 0;
  const raw = fc.features[i].geometry.coordinates.map(P.fwd);
  let inB = 0, worstFloat = 0, worstStray = 0, floatAt = null, bAt = null, strayAt = null;
  for (const part of f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates]) {
    const c = part.map(P.fwd);
    if (c.length < 2) continue;
    const drawn = c.map((p, k) => { const a = c[Math.max(0, k - 1)], b = c[Math.min(c.length - 1, k + 1)], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [p[0] + (side * off * (b[1] - a[1])) / L, p[1] - (side * off * (b[0] - a[0])) / L]; });
    for (let k = 1; k < drawn.length; k++) {
      const [ax, ay] = drawn[k - 1], [bx, by] = drawn[k], L = Math.hypot(bx - ax, by - ay);
      for (let s = 0; s <= L; s += 2) {
        const p = [ax + ((bx - ax) * s) / (L || 1), ay + ((by - ay) * s) / (L || 1)];
        const onRoad = onSomeRoad(p, ridx, 0.5);
        if (!onRoad && bidx.inside(p)) { inB += 2; bAt ||= p; }
        if (!onRoad) { let ex = Infinity; for (const sg of ridx.near(p)) ex = Math.min(ex, dist(p, [[sg.ax, sg.ay], [sg.ax + sg.dx, sg.ay + sg.dy]]) - half(sg.cls)); if (ex > worstFloat) { worstFloat = ex; floatAt = p; } }
        const d = dist(p, raw); if (d > worstStray) { worstStray = d; strayAt = p; }
      }
      if (k >= 2) {
        const [px, py] = drawn[k - 2], ux = ax - px, uy = ay - py, vx = bx - ax, vy = by - ay;
        if ((ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1) < 0.5 && Math.min(Math.hypot(ux, uy), Math.hypot(vx, vy)) > 1) flag("sharp-turn", drawn[k - 1], f.properties.curb_zone_id);
      }
    }
    for (const [k, nb] of [[0, 1], [drawn.length - 1, drawn.length - 2]]) {
      const p = drawn[k], q = drawn[nb], L = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1, fx = (p[0] - q[0]) / L, fy = (p[1] - q[1]) / L;
      ends.push({ p, u: k === 0 ? [-fx, -fy] : [fx, fy], start: k === 0, i, side });
      for (const sg of ridx.near(p)) {
        if (Math.abs(fx * sg.ux + fy * sg.uy) > 0.5) continue;
        const t = ((p[0] - sg.ax) * sg.dx + (p[1] - sg.ay) * sg.dy) / (sg.L * sg.L);
        if (t > 0 && t < 1 && Math.hypot(p[0] - sg.ax - t * sg.dx, p[1] - sg.ay - t * sg.dy) < half(sg.cls)) { flag("into-cross-street", p, f.properties.curb_zone_id); break; }
      }
    }
  }
  if (inB >= 6) flag("through-buildings", bAt, `${inB} m`);
  if (worstFloat > 0.5) flag("floating", floatAt, `${worstFloat.toFixed(1)} m off`);
  if (worstStray > 10) flag("stray", strayAt, `${worstStray.toFixed(0)} m from city geometry`);
});
// Jogs: a line's end and the next line's start, running the same way, close along the street but offset sideways.
const grid = new Map(), key = (x, y) => `${Math.floor(x / 10)},${Math.floor(y / 10)}`;
for (const e of ends) if (e.start) (grid.get(key(...e.p)) || grid.set(key(...e.p), []).get(key(...e.p))).push(e);
for (const e of ends) {
  if (e.start) continue;
  const gx = Math.floor(e.p[0] / 10), gy = Math.floor(e.p[1] / 10);
  for (let a = gx - 1; a <= gx + 1; a++) for (let b = gy - 1; b <= gy + 1; b++) for (const o of grid.get(`${a},${b}`) || []) {
    if (o.i === e.i || e.u[0] * o.u[0] + e.u[1] * o.u[1] < 0.985) continue; // same direction, not a bend
    const dx = o.p[0] - e.p[0], dy = o.p[1] - e.p[1], along = dx * e.u[0] + dy * e.u[1], lat = Math.abs(-dx * e.u[1] + dy * e.u[0]);
    if (along > -3 && along < 6 && lat > 0.8 && lat < 6) flag("jog", e.p, `${lat.toFixed(1)} m (${e.side ? "snapped" : "unsnapped"}/${o.side ? "snapped" : "unsnapped"})`);
  }
}

const drawnCount = features.filter((f) => f.geometry).length;
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ drawn: drawnCount, stats: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length])), found }, null, 1));
} else {
  console.log(`${drawnCount.toLocaleString()} curbs drawn (${(fc.features.length - drawnCount).toLocaleString()} hidden)\n`);
  for (const [k, v] of Object.entries(found)) {
    console.log(`${k.padEnd(18)} ${String(v.length).padStart(5)}  (${((100 * v.length) / drawnCount).toFixed(2)}%)`);
    for (const x of v.slice(0, 3)) console.log(`${"".padEnd(26)}${x.at.join(", ")}  ${x.detail}`);
  }
}
