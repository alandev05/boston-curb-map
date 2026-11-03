import { describe, it, expect } from "vitest";
import { lineSlice, applyCommunity } from "../scripts/community.js";
import { projector, lineLength } from "../scripts/snap.js";
import { verdict } from "../src/rules.js";

const P = projector(42.35), O = P.fwd([-71.08, 42.35]);
const at = (x, y = 0) => P.inv([O[0] + x, O[1] + y]);
const curb = (len = 100) => ({ type: "Feature", properties: { curb_zone_id: "zone-a", curb_policy_ids: ["hydrant"] }, geometry: { type: "LineString", coordinates: [at(0), at(len / 2), at(len)] } });
const POLICIES = { hydrant: { curb_policy_id: "hydrant", priority: 1, rules: [{ activity: "no stopping" }], time_spans: [] } };
const PAID = { priority: 80, rules: [{ activity: "parking", max_stay: 120, max_stay_unit: "minute" }], rates: [{ rate: 375, rate_unit: "hour" }], time_spans: [{ days_of_week: ["mon", "tue", "wed", "thu", "fri", "sat"], time_of_day_start: "08:00", time_of_day_end: "18:00" }] };
const sub = (id, extra) => ({ id: `${id}0000000-0000-4000-8000-000000000000`, curb_zone_id: "zone-a", stretch_from: null, stretch_to: null, curb_length: 100, rules: [PAID], reviewed_at: "2026-11-01T00:00:00Z", ...extra });

describe("lineSlice", () => {
  it("cuts the part between two distances along a line", () => {
    const c = curb().geometry.coordinates;
    expect(lineLength(lineSlice(c, 20, 70))).toBeCloseTo(50, 0);
    expect(lineLength(lineSlice(c, 0, 100))).toBeCloseTo(100, 0);
  });
});

describe("applyCommunity", () => {
  it("a whole-curb correction replaces the curb's rules", () => {
    const pols = { ...POLICIES };
    const { features } = applyCommunity([curb()], pols, [sub("a")]);
    expect(features).toHaveLength(1);
    expect(features[0].properties._community).toMatch(/^a/);
    expect(verdict(features[0].properties, pols, "tue", 600).category).toBe("paid");
    expect(pols[features[0].properties.curb_policy_ids[0]].source).toBe("community");
  });
  it("a stretch cuts the curb in three; only the middle takes the correction", () => {
    const pols = { ...POLICIES };
    const { features } = applyCommunity([curb()], pols, [sub("a", { stretch_from: 30, stretch_to: 60 })]);
    expect(features.map((f) => [f.properties._from, f.properties._to, !!f.properties._community])).toEqual([[0, 30, false], [30, 60, true], [60, 100, false]]);
    expect(lineLength(features[1].geometry.coordinates)).toBeCloseTo(30, 0);
    expect(features[0].properties.curb_policy_ids).toEqual(["hydrant"]);
  });
  it("where accepted corrections overlap, the latest review wins", () => {
    const pols = { ...POLICIES };
    const older = sub("a", { reviewed_at: "2026-10-01T00:00:00Z" });
    const newer = sub("b", { stretch_from: 50, stretch_to: 100, reviewed_at: "2026-11-01T00:00:00Z", rules: [{ priority: 10, rules: [{ activity: "no stopping" }], time_spans: [{ days_of_week: ["mon"], time_of_day_start: "00:00", time_of_day_end: "00:00" }] }] });
    const { features } = applyCommunity([curb()], pols, [newer, older]);
    expect(features.map((f) => f.properties._community[0])).toEqual(["a", "b"]);
  });
  it("leaves other curbs alone and counts corrections for curbs no longer in the feed", () => {
    const other = { ...curb(), properties: { curb_zone_id: "zone-b", curb_policy_ids: [] } };
    const { features, stats } = applyCommunity([other], { ...POLICIES }, [sub("a")]);
    expect(features).toEqual([other]);
    expect(stats.missing).toBe(1);
  });
});
