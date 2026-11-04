import { describe, it, expect } from "vitest";
import { newCard, cardToPolicy, policyToCards, cardsFor, validateRules } from "../src/submission.js";
import { verdict, categorize, ruleOf, isMetered } from "../src/rules.js";

const zoneOf = (...pols) => { const map = {}; pols.forEach((p, i) => (map[`p${i}`] = { ...p, curb_policy_id: `p${i}` })); return [{ curb_policy_ids: Object.keys(map) }, map]; };

describe("rule cards → policies", () => {
  it("a paid card is a metered rule with its limit and rate, in force on its days and hours", () => {
    const p = cardToPolicy({ ...newCard("paid"), rate: 3.75 }, "x");
    expect(isMetered(p)).toBe(true);
    expect(ruleOf(p).max_stay).toBe(120);
    expect(p.rates[0].rate).toBe(375);
    const [z, map] = zoneOf(p);
    expect(verdict(z, map, "tue", 10 * 60).category).toBe("paid");
    expect(verdict(z, map, "tue", 19 * 60).category).toBe("free"); // after 6 PM the meter is off
  });
  it("each type grades as its own category", () => {
    for (const type of ["no_stopping", "no_parking", "loading", "resident", "accessible", "free"]) expect(categorize(ruleOf(cardToPolicy(newCard(type), "x")))).toBe(type);
  });
  it("street cleaning keeps weeks of the month and months", () => {
    const p = cardToPolicy({ ...newCard("street_cleaning"), days: ["tue"], weeks: [1, 3], months: [4, 11] }, "x");
    expect(p.time_spans[0]).toMatchObject({ days_of_week: ["tue"], weeks_of_month: [1, 3], months: [4, 5, 6, 7, 8, 9, 10, 11] });
  });
  it("months can wrap the year (Nov–Mar)", () => {
    expect(cardToPolicy({ ...newCard("street_cleaning"), months: [11, 3] }, "x").time_spans[0].months).toEqual([11, 12, 1, 2, 3]);
  });
  it("all day is 00:00–00:00", () => {
    expect(cardToPolicy({ ...newCard("no_stopping"), allDay: true }, "x").time_spans[0]).toMatchObject({ time_of_day_start: "00:00", time_of_day_end: "00:00" });
  });
});

describe("policies → rule cards (editor prefill)", () => {
  it("round-trips a card", () => {
    const c = { ...newCard("street_cleaning"), days: ["wed"], weeks: [2, 4], months: [4, 11], start: "08:00", end: "12:00" };
    expect(policyToCards(cardToPolicy(c, "x"))[0]).toMatchObject({ type: "street_cleaning", days: ["wed"], weeks: [2, 4], months: [4, 11], start: "08:00", end: "12:00" });
  });
  it("leaves out snow-emergency-only rules and rules the editor can't express", () => {
    expect(policyToCards({ rules: [{ activity: "no parking" }], time_spans: [{ designated_period: '{"snow emergency"}', time_of_day_start: "00:00", time_of_day_end: "00:00" }] })).toEqual([]);
    expect(policyToCards({ rules: [{ activity: "unusable image" }], time_spans: [] })).toEqual([]);
  });
  it("the same rule listed twice, or split by weekday, is one card", () => {
    const mon = { ...newCard("street_cleaning"), days: ["mon"], start: "00:00", end: "07:00" };
    const twice = cardsFor([cardToPolicy(mon, "a"), cardToPolicy(mon, "b")]);
    expect(twice).toHaveLength(1);
    const split = cardsFor([cardToPolicy(mon, "a"), cardToPolicy({ ...mon, days: ["thu"] }, "b")]);
    expect(split.map((c) => c.days)).toEqual([["mon", "thu"]]);
    expect(cardsFor([cardToPolicy(mon, "a"), cardToPolicy({ ...mon, end: "08:00" }, "b")])).toHaveLength(2); // different hours stay apart
  });
  it("on a metered curb, free-parking signs are implied and left out", () => {
    const meter = cardToPolicy(newCard("paid"), "m"), sign = cardToPolicy({ ...newCard("free"), limit: 120 }, "f");
    expect(cardsFor([meter, sign]).map((c) => c.type)).toEqual(["paid"]);
    expect(cardsFor([sign]).map((c) => c.type)).toEqual(["free"]);
  });
});

describe("validateRules", () => {
  const good = () => [cardToPolicy(newCard("paid"), "a")];
  it("accepts editor output and keeps only the fields the build reads", () => {
    const [p] = validateRules([{ ...good()[0], curb_policy_id: "evil", extra: 1 }]);
    expect(p.curb_policy_id).toBeUndefined();
    expect(p.extra).toBeUndefined();
    expect(p.rules[0]).toEqual({ activity: "parking", max_stay: 120, max_stay_unit: "minute" });
  });
  it("rejects nonsense", () => {
    expect(() => validateRules([])).toThrow(/at least one/);
    expect(() => validateRules([{ ...good()[0], rules: [{ activity: "teleport" }] }])).toThrow(/unknown kind/);
    expect(() => validateRules([{ ...good()[0], time_spans: [{ days_of_week: [], time_of_day_start: "08:00", time_of_day_end: "18:00" }] }])).toThrow(/day/);
    expect(() => validateRules([{ ...good()[0], time_spans: [{ days_of_week: ["mon"], time_of_day_start: "8am", time_of_day_end: "18:00" }] }])).toThrow(/time/);
    expect(() => validateRules([{ ...good()[0], rules: [{ activity: "parking", user_classes: ["admin"] }] }])).toThrow(/user class/);
    expect(() => validateRules(Array.from({ length: 13 }, good).flat())).toThrow(/at most/);
  });
});
