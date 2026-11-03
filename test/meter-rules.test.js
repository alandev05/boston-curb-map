import { describe, it, expect } from "vitest";
import { parseMeterSchedule, assignMeters } from "../scripts/meters.js";
import { verdict } from "../src/rules.js";
import { projector } from "../scripts/snap.js";

const P = projector(42.35), O = P.fwd([-71.08, 42.35]);
const at = (x, y) => P.inv([O[0] + x, O[1] + y]); // meters → lon/lat
const zone = (id, x0, x1, ids) => ({ type: "Feature", properties: { curb_zone_id: id, curb_policy_ids: ids }, geometry: { type: "LineString", coordinates: [at(x0, 0), at(x1, 0)] } });
const meter = (x, props = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: at(x, 1.5) }, properties: { METER_STATE: "ACTIVE", PAY_POLICY: "08:00AM-08:00PM MON-SAT $0.25 120", ...props } });
const WEEK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const POLICIES = {
  hydrant: { curb_policy_id: "hydrant", priority: 1, description: "* No Stopping Fire Hydrant", rules: [{ activity: "no stopping" }], time_spans: [] },
  feedMeter: { curb_policy_id: "feedMeter", priority: 83, description: "* 2-Hour Parking 8:00 AM-6:00 PM (Metered)", rules: [{ activity: "parking", max_stay: 120, max_stay_unit: "minute" }], rates: [{ rate: 375, rate_unit: "hour" }],
    time_spans: [{ days_of_week: WEEK.slice(1), time_of_day_start: "08:00", time_of_day_end: "18:00" }] },
  resident: { curb_policy_id: "resident", priority: 40, description: "* Parking Resident Only", rules: [{ activity: "parking", user_classes: ["resident_permit"] }], time_spans: [] },
  cleaning: { curb_policy_id: "cleaning", priority: 20, description: "* No Parking 8:00 AM-12:00 PM", rules: [{ activity: "no parking" }],
    time_spans: [{ days_of_week: ["tue"], time_of_day_start: "08:00", time_of_day_end: "12:00", weeks_of_month: [1, 3] }] },
};

describe("parseMeterSchedule", () => {
  it("reads hours, days and the time limit", () => {
    expect(parseMeterSchedule("08:00AM-08:00PM MON-SAT $0.25 120")).toEqual([{ days: WEEK.slice(1), start: "08:00", end: "20:00", max: 120 }]);
  });
  it("reads several parts, midnight as 24:00, and tow-away strings with no price", () => {
    expect(parseMeterSchedule("08:00AM-04:00PM MON-FRI $0.25 120, 08:00AM-06:00PM SAT $0.25 120").map((s) => [s.days.join(), s.start, s.end])).toEqual([["mon,tue,wed,thu,fri", "08:00", "16:00"], ["sat", "08:00", "18:00"]]);
    expect(parseMeterSchedule("08:00PM-24:00AM MON-SAT")[0]).toMatchObject({ start: "20:00", end: "24:00" });
    expect(parseMeterSchedule("04:00PM-06:00PM MON-FRI")[0]).toMatchObject({ start: "16:00", end: "18:00", max: null });
  });
});

describe("assignMeters", () => {
  const run = (features, meters) => { const pols = { ...POLICIES }; return { ...assignMeters(features, pols, meters), pols }; };
  it("a meter's schedule replaces the feed's meter rule on the curb it stands beside, keeping the feed's rate", () => {
    const { features, pols } = run([zone("a", 0, 60, ["feedMeter"])], [meter(20)]);
    const ids = features[0].properties.curb_policy_ids;
    expect(ids).not.toContain("feedMeter");
    expect(verdict({ curb_policy_ids: ids }, pols, "tue", 19 * 60).category).toBe("paid"); // the meter runs to 8 PM, not the feed's 6 PM
    expect(verdict({ curb_policy_ids: ids }, pols, "tue", 21 * 60).category).toBe("free"); // PARK_NO_PAY
    expect(pols[ids[0]].rates[0].rate).toBe(375);
  });
  it("rule ids never contain commas (rule sets are comma-joined)", () => {
    const { features } = run([zone("a", 0, 60, ["feedMeter"])], [meter(20, { PAY_POLICY: "08:00AM-04:00PM MON-FRI $0.25 120, 08:00AM-06:00PM SAT $0.25 120", TOW_AWAY: "04:00PM-06:00PM MON-FRI" })]);
    for (const id of features[0].properties.curb_policy_ids) expect(id).not.toMatch(/,/);
  });
  it("gives a curb with no rules the meter's schedule", () => {
    const { features, pols } = run([zone("a", 0, 60, [])], [meter(20)]);
    expect(verdict(features[0].properties, pols, "sat", 10 * 60).category).toBe("paid");
  });
  it("a hydrant listed on a long metered block covers only part of it", () => {
    const { features, pols } = run([zone("a", 0, 90, ["hydrant", "feedMeter"])], [meter(20), meter(50)]);
    const ids = features[0].properties.curb_policy_ids;
    expect(ids).toContain("~hydrant");
    expect(verdict({ curb_policy_ids: ids }, pols, "tue", 10 * 60).category).toBe("paid");
  });
  it("a hydrant's own short curb keeps its no stopping", () => {
    const { features } = run([zone("a", 0, 5, ["hydrant", "feedMeter"])], []);
    expect(features[0].properties.curb_policy_ids).toContain("hydrant");
  });
  it("an all-day resident rule on a metered curb is part of it; time-limited cleaning still covers it all", () => {
    const { features } = run([zone("a", 0, 40, ["resident", "cleaning", "feedMeter"])], [meter(10)]);
    const ids = features[0].properties.curb_policy_ids;
    expect(ids).toContain("~resident");
    expect(ids).toContain("cleaning");
  });
  it("pieces of a curb cut by a community correction keep the whole curb's meters and length", () => {
    // 0–20 m and 45–93 m of one 93 m curb; the only meter stands beside the second piece.
    const piece = (x0, x1) => ({ ...zone("a", x0, x1, ["hydrant", "feedMeter"]), properties: { curb_zone_id: "a", curb_policy_ids: ["hydrant", "feedMeter"], _rawLen: 93 } });
    const { features } = run([piece(0, 20), piece(45, 93)], [meter(70)]);
    expect(features[0].properties.curb_policy_ids).toContain("~hydrant");
    expect(features[0].properties.curb_policy_ids.some((id) => id.startsWith("meter-"))).toBe(true);
  });
  it("adds the meter's tow-away hours as no stopping", () => {
    const { features, pols } = run([zone("a", 0, 60, [])], [meter(20, { TOW_AWAY: "04:00PM-06:00PM MON-FRI" })]);
    expect(verdict(features[0].properties, pols, "wed", 17 * 60).category).toBe("no_stopping");
    expect(verdict(features[0].properties, pols, "sat", 17 * 60).category).toBe("paid");
  });
  it("ignores a meter across the street (too far) or past the curb's end", () => {
    const { features } = run([zone("a", 0, 30, [])], [{ ...meter(10), geometry: { type: "Point", coordinates: at(10, 15) } }, meter(45)]);
    expect(features[0].properties.curb_policy_ids).toEqual([]);
  });
});
