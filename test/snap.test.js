import { describe, it, expect } from "vitest";
import { snapZones, projector, lineLength } from "../scripts/snap.js";

// A straight east–west street at lat 42.35 and a north–south cross street through its middle.
const LAT = 42.35, P = projector(LAT);
const at = (x, y) => P.inv([P.fwd([-71.08, LAT])[0] + x, P.fwd([-71.08, LAT])[1] + y]); // meters → lon/lat
const ROADS = [
  { cls: "minor", coords: [at(-200, 0), at(200, 0)] },
  { cls: "primary", coords: [at(0, -200), at(0, 200)] },
];
const zone = (coords, id = "z") => ({ type: "Feature", properties: { curb_zone_id: id }, geometry: { type: "LineString", coordinates: coords } });
const expectSameLine = (a, b) => { expect(a.length).toBe(b.length); a.forEach((c, i) => { expect(c[0]).toBeCloseTo(b[i][0], 6); expect(c[1]).toBeCloseTo(b[i][1], 6); }); };
const ys = (f) => f.geometry.coordinates.map((c) => P.fwd(c)[1] - P.fwd(at(0, 0))[1]);

describe("snapZones", () => {
  it("moves a curb 5 m north of the street onto the centerline, tagged with its side and road class", () => {
    const { features, snapped } = snapZones([zone([at(-80, 5), at(-20, 5)])], ROADS);
    expect(snapped).toBe(1);
    for (const y of ys(features[0])) expect(Math.abs(y)).toBeLessThan(0.05);
    // drawn west→east, north is to the left of travel
    expect(features[0].properties._side).toBe(-1);
    expect(features[0].properties._rc).toBe("minor");
  });
  it("the same curb drawn the other way, or on the other side, flips the side", () => {
    expect(snapZones([zone([at(-20, 5), at(-80, 5)])], ROADS).features[0].properties._side).toBe(1);
    expect(snapZones([zone([at(-80, -5), at(-20, -5)])], ROADS).features[0].properties._side).toBe(1);
  });
  it("ignores the perpendicular cross street near a corner", () => {
    const f = snapZones([zone([at(2, 6), at(30, 6)])], ROADS).features[0];
    expect(f.properties._rc).toBe("minor");
  });
  it("leaves curbs that don't follow any road untouched (side 0 downstream)", () => {
    const far = zone([at(-80, 60), at(-20, 60)]);
    const { features, snapped } = snapZones([far], ROADS);
    expect(snapped).toBe(0);
    expect(features[0].properties._side).toBeUndefined();
    expectSameLine(features[0].geometry.coordinates, far.geometry.coordinates);
  });
  it("is a no-op without roads", () => {
    const f = zone([at(-80, 5), at(-20, 5)]);
    expect(snapZones([f], null).features[0]).toBe(f);
  });
  it("splits a curb that wraps a corner into one run per street instead of a spike across the intersection", () => {
    // NE corner: runs west→east along the street 5 m north, then turns north along the cross street 5 m east.
    const f = snapZones([zone([at(-60, 5), at(5, 5), at(5, 60)])], ROADS).features[0];
    expect(f.geometry.type).toBe("MultiLineString");
    const [a, b] = f.geometry.coordinates.map((part) => part.map((c) => P.fwd(c).map((n, k) => n - P.fwd(at(0, 0))[k])));
    for (const [, y] of a) expect(Math.abs(y)).toBeLessThan(0.05); // first run on the east–west street
    for (const [x] of b) expect(Math.abs(x)).toBeLessThan(0.05); // second run on the cross street
    // the road is on the same side throughout (right of travel), so one side value covers both runs
    expect(f.properties._side).toBe(-1);
  });
  it("doesn't zigzag onto a parallel road on the same side (e.g. the far carriageway)", () => {
    const roads = [...ROADS, { cls: "minor", coords: [at(-200, -7), at(200, -7)] }];
    const f = snapZones([zone([at(-80, 4.6), at(-50, 2.5), at(-20, 4.6)])], roads).features[0];
    expect(new Set(ys(f).map((v) => Math.round(v))).size).toBe(1); // all on one road
    expect(f.geometry.type).toBe("LineString");
  });
  it("keeps a curb that runs between two parallel roads (a median) at its true position", () => {
    // carriageways 16 m apart: drawn edges 6.5 m apart, a visible median
    const roads = [...ROADS, { cls: "minor", coords: [at(-200, 16), at(200, 16)] }];
    const median = zone([at(-80, 4.6), at(-50, 4.4), at(-20, 4.6)]);
    const { features, snapped } = snapZones([median], roads);
    expect(snapped).toBe(0);
    expect(features[0].properties._side).toBeUndefined();
    expectSameLine(features[0].geometry.coordinates, median.geometry.coordinates);
  });
  it("puts a curb inside a divided road whose carriageways merge into one drawn road on the nearer one's outer edge", () => {
    // carriageways 12 m apart (drawn edges overlap); the curb lies between them, nearer the north one
    const roads = [...ROADS, { cls: "minor", coords: [at(-200, 12), at(200, 12)] }];
    const f = snapZones([zone([at(-80, 8), at(-50, 7.6), at(-20, 8)])], roads).features[0];
    expect(f.properties._side).toBeDefined();
    for (const y of ys(f)) expect(y).toBeCloseTo(12, 1); // on the north carriageway's centerline…
    expect(f.properties._side).toBe(-1); // …offset to its north (left of west→east travel), the outer edge
  });
  it("never draws a curb on the hidden inner edge of a divided road", () => {
    // carriageways 7 m apart; the curb sits just north of the south one. With the both-sides check off (between: 0)
    // it matches the south carriageway normally and would be drawn on its north edge, inside the north carriageway.
    const roads = [{ cls: "minor", coords: [at(-200, 0), at(200, 0)] }, { cls: "minor", coords: [at(-200, 7), at(200, 7)] }];
    const f = snapZones([zone([at(-80, 1), at(-20, 1)])], roads, { between: 0 }).features[0];
    for (const y of ys(f)) expect(Math.abs(y)).toBeLessThan(0.05);
    expect(f.properties._side).toBe(1); // south edge (right of west→east travel), the outer one
  });
  it("stops a curb short of the cross street instead of overlapping that street's curbs", () => {
    // North-side curb running east into the primary cross street at x=0 (half-width 6 m) — ends at the corner, x=-2.
    const f = snapZones([zone([at(-60, 5), at(-2, 5)])], ROADS).features[0];
    const xs = f.geometry.coordinates.map((c) => P.fwd(c)[0] - P.fwd(at(0, 0))[0]);
    const end = Math.max(...xs);
    expect(end).toBeLessThan(-7); // ≥ half-width (6) + setback (1.5) from the cross street's centerline
    expect(end).toBeGreaterThan(-8.5);
    expect(Math.min(...xs)).toBeCloseTo(-60, 0); // the far end is untouched
  });
  it("doesn't trim at a T-junction on the far side of the road", () => {
    const roads = [{ cls: "minor", coords: [at(-200, 0), at(200, 0)] }, { cls: "minor", coords: [at(0, -200), at(0, 0)] }];
    const f = snapZones([zone([at(-60, 5), at(30, 5)])], roads).features[0]; // north curb runs straight past a T to the south
    const xs = f.geometry.coordinates.map((c) => P.fwd(c)[0] - P.fwd(at(0, 0))[0]);
    expect(Math.max(...xs)).toBeCloseTo(30, 0);
  });
  it("stops a side street's curb short of a main road it meets at a shallow angle", () => {
    // Like Fencourt St into Huntington Ave: a service road meets the primary at 50°, ending on its centerline.
    const u = [-Math.cos(Math.PI * 50 / 180), Math.sin(Math.PI * 50 / 180)], n = [u[1], -u[0]];
    const along = (s, o = 0) => at(s * u[0] + o * n[0], s * u[1] + o * n[1]);
    const roads = [{ cls: "primary", coords: [at(-200, 0), at(200, 0)] }, { cls: "service", coords: [along(0), along(90)] }];
    const f = snapZones([zone([along(70, 4), along(1, 4)])], roads).features[0];
    expect(f.properties._rc).toBe("service");
    // Drawn 2.75 m off the service centerline, the end must clear the primary's 6 m half-width + setback.
    const minY = Math.min(...ys(f));
    expect(minY).toBeGreaterThan(4);
  });
  it("doesn't trim a curb where its own street bends onto its next way", () => {
    // Two ways of one street joined at a node no other road touches, bending 40°.
    const b = [Math.cos(Math.PI * 40 / 180), Math.sin(Math.PI * 40 / 180)];
    const roads = [{ cls: "minor", coords: [at(-200, 0), at(0, 0)] }, { cls: "minor", coords: [at(0, 0), at(100 * b[0], 100 * b[1])] }];
    const f = snapZones([zone([at(-60, 5), at(0, 5)])], roads).features[0];
    const xs = f.geometry.coordinates.map((c) => P.fwd(c)[0] - P.fwd(at(0, 0))[0]);
    expect(Math.max(...xs)).toBeGreaterThan(-1);
  });
  it("pulls a curb that won't snap but floats off the road onto the road's drawn edge", () => {
    // Runs off at 45° (fails the heading test on both passes), ending 22 m out — far beyond the 4.75 m half-width.
    const f = snapZones([zone([at(-90, 2), at(-70, 22)])], ROADS).features[0];
    expect(f.properties._side).toBeUndefined();
    for (const y of ys(f)) expect(Math.abs(y)).toBeLessThanOrEqual(4.75);
  });
  it("doesn't draw a curb that lies entirely inside an intersection", () => {
    const { features, stats } = snapZones([zone([at(-4, 5), at(-1, 5)])], ROADS);
    expect(features[0].geometry).toBeNull();
    expect(stats.hiddenInIntersection).toBe(1);
  });
  it("a curb that won't snap on its own follows the snapped curb it continues, so the line doesn't jog", () => {
    const a = zone([at(-80, 5), at(-40, 5)], "a");
    // Continues a at a 35° skew (fails the normal heading test) but stays inside the road band, so it isn't floating.
    const b = zone([at(-40, 4.5), at(-34, 0.3)], "b");
    const { features, stats } = snapZones([a, b], ROADS);
    expect(features[0].properties._side).toBe(-1);
    expect(features[1].properties._side).toBe(-1); // same side, same road → drawn on the same edge as a
    expect(stats.followed).toBe(1);
  });
  it("keeps length roughly intact", () => {
    const f = snapZones([zone([at(-80, 5), at(-20, 5)])], ROADS).features[0];
    expect(lineLength(f.geometry.coordinates)).toBeCloseTo(60, 0);
  });
});
