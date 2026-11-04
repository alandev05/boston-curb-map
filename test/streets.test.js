import { describe, it, expect } from "vitest";
import { buildStreets } from "../scripts/streets.js";
import { projector } from "../scripts/snap.js";

const P = projector(42.35), O = P.fwd([-71.08, 42.35]);
const at = (x, y) => P.inv([O[0] + x, O[1] + y]); // meters → lon/lat
const curb = (coords) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });
const places = [{ name: "Back Bay", cls: "suburb", coord: at(0, 0) }, { name: "Dorchester", cls: "suburb", coord: at(0, -5000) }];

describe("buildStreets", () => {
  it("joins a street's pieces across tile edges (overlapping) into one entry, labeled with its neighborhood", () => {
    const names = [{ name: "Main Street", coords: [at(0, 10), at(300, 10)] }, { name: "Main Street", coords: [at(260, 10), at(600, 10)] }];
    const out = buildStreets(names, places, [curb([at(50, 15), at(100, 15)])]);
    expect(out).toHaveLength(1);
    expect(out[0].slice(0, 2)).toEqual(["Main Street", "Back Bay"]);
    expect(out[0][2]).toBeCloseTo(-71.08, 3); // west edge
  });
  it("keeps same-named streets far apart as separate entries, and drops streets without curbs", () => {
    const names = [{ name: "Washington Street", coords: [at(0, 0), at(200, 0)] }, { name: "Washington Street", coords: [at(0, -5000), at(200, -5000)] },
      { name: "Storrow Drive", coords: [at(0, 2000), at(400, 2000)] }];
    const out = buildStreets(names, places, [curb([at(10, 5), at(80, 5)]), curb([at(10, -4995), at(80, -4995)])]);
    expect(out.map((r) => r.slice(0, 2))).toEqual([["Washington Street", "Back Bay"], ["Washington Street", "Dorchester"]]);
  });
});
