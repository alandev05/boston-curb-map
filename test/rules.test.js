import { describe, it, expect } from "vitest";
import { spanActive, policyActive, categorize, verdict, fmtRate, fmtSpan, dayKey, CATEGORIES, cityHolidays, cityHoliday, nextDate, ruleOf, stayWindow, evaluateStay, isStreetCleaning, collapsePolicies, overriddenBy, allowedFor } from "../src/rules.js";

const span = (o) => ({ days_of_week: ["mon", "tue", "wed", "thu", "fri", "sat"], time_of_day_start: "08:00", time_of_day_end: "20:00", ...o });
const M = (h, m = 0) => h * 60 + m;

describe("spanActive", () => {
  it("is always active when span is missing", () => expect(spanActive(undefined, "sun", 0)).toBe(true));
  it("respects day of week", () => {
    expect(spanActive(span(), "mon", M(10))).toBe(true);
    expect(spanActive(span(), "sun", M(10))).toBe(false);
  });
  it("accepts full day names and mixed case", () => {
    expect(spanActive(span({ days_of_week: ["Monday", "TUESDAY"] }), "tue", M(10))).toBe(true);
    expect(spanActive(span({ days_of_week: ["Monday"] }), "wed", M(10))).toBe(false);
  });
  it("start inclusive, end exclusive", () => {
    expect(spanActive(span(), "mon", M(8))).toBe(true);
    expect(spanActive(span(), "mon", M(7, 59))).toBe(false);
    expect(spanActive(span(), "mon", M(19, 59))).toBe(true);
    expect(spanActive(span(), "mon", M(20))).toBe(false);
  });
  it("handles overnight spans (22:00–06:00)", () => {
    const s = span({ days_of_week: undefined, time_of_day_start: "22:00", time_of_day_end: "06:00" });
    expect(spanActive(s, "mon", M(23))).toBe(true);
    expect(spanActive(s, "mon", M(2))).toBe(true);
    expect(spanActive(s, "mon", M(12))).toBe(false);
    expect(spanActive(s, "mon", M(6))).toBe(false);
  });
  it("handles open-ended times", () => {
    expect(spanActive({ time_of_day_start: "18:00" }, "mon", M(23))).toBe(true);
    expect(spanActive({ time_of_day_start: "18:00" }, "mon", M(9))).toBe(false);
    expect(spanActive({ time_of_day_end: "09:00" }, "mon", M(8))).toBe(true);
    expect(spanActive({ time_of_day_end: "09:00" }, "mon", M(9))).toBe(false);
  });
  it("treats 00:00–00:00 as all day (how the Boston feed encodes 24h rules)", () => {
    const s = span({ time_of_day_start: "00:00", time_of_day_end: "00:00" });
    expect(spanActive(s, "mon", M(0))).toBe(true);
    expect(spanActive(s, "mon", M(12))).toBe(true);
    expect(spanActive(s, "sun", M(12))).toBe(false);
  });
  it("event-only periods (snow emergency, game days) are off under normal conditions", () => {
    expect(spanActive(span({ designated_period: '{"snow emergency"}' }), "mon", M(10))).toBe(false);
    expect(spanActive(span({ designated_period: "{holidays}" }), "mon", M(10))).toBe(false);
    expect(spanActive(span({ designated_period: '{"school days"}' }), "mon", M(10))).toBe(true);
  });
  it("respects months", () => {
    const s = span({ months: [4, 5, 6, 7, 8, 9, 10, 11] });
    expect(spanActive(s, "mon", M(10), new Date("2026-06-01T12:00:00"))).toBe(true);
    expect(spanActive(s, "mon", M(10), new Date("2026-01-15T12:00:00"))).toBe(false);
  });
  it("respects seasonal date bounds", () => {
    expect(spanActive({ start_date: "2099-01-01" }, "mon", M(10))).toBe(false);
    expect(spanActive({ end_date: "2000-01-01" }, "mon", M(10))).toBe(false);
    expect(spanActive({ start_date: "2000-01-01", end_date: "2099-01-01" }, "mon", M(10))).toBe(true);
  });
  it("treats an empty days array as every day", () => expect(spanActive(span({ days_of_week: [] }), "sun", M(10))).toBe(true));
});

describe("policyActive", () => {
  it("is active with no time spans", () => expect(policyActive({ rules: [] }, "sun", 0)).toBe(true));
  it("is active if ANY span matches", () => {
    const p = { time_spans: [span({ days_of_week: ["mon"] }), span({ days_of_week: ["sat"] })] };
    expect(policyActive(p, "sat", M(10))).toBe(true);
    expect(policyActive(p, "sun", M(10))).toBe(false);
  });
});

describe("categorize", () => {
  const cases = [
    [{ activity: "travel" }, "travel"],
    [{ activity: "no stopping" }, "no_stopping"],
    [{ activity: "no_stopping" }, "no_stopping"],
    [{ activity: "No Parking" }, "no_parking"],
    [{ activity: "no standing" }, "no_parking"],
    [{ activity: "loading" }, "loading"],
    [{ activity: "unloading" }, "loading"],
    [{ activity: "parking", purposes: ["commercial loading"] }, "loading"],
    [{ activity: "parking", user_classes: ["commercial"] }, "loading"],
    [{ activity: "parking", user_classes: ["disabled placard"] }, "accessible"],
    [{ activity: "parking", user_classes: ["resident permit"] }, "resident"],
    [{ activity: "parking", purposes: ["resident permit parking"] }, "resident"],
    [{ activity: "parking", rate: [{ rate: 375, rate_unit: "hour" }] }, "paid"],
    [{ activity: "parking", rates: [{ rate: 100 }] }, "paid"],
    [{ activity: "parking", user_classes: ["car"] }, "free"],
    [{ activity: "stopping" }, "free"],
    [{ activity: "weird" }, "unknown"],
    [{}, "unknown"],
  ];
  it.each(cases)("%j → %s", (rule, expected) => expect(categorize(rule)).toBe(expected));
  it("accessible beats paid (placard holders park free at meters)", () => {
    expect(categorize({ activity: "parking", user_classes: ["disabled"], rate: [{ rate: 100 }] })).toBe("accessible");
  });
  it("every category has a legend entry", () => {
    for (const [, exp] of cases) expect(CATEGORIES[exp]).toBeDefined();
  });
});

describe("verdict", () => {
  const policies = {
    meter: { curb_policy_id: "meter", priority: 10, rules: [{ activity: "parking", max_stay: 120, rate: [{ rate: 375, rate_unit: "hour" }] }], time_spans: [span()] },
    rpp: { curb_policy_id: "rpp", priority: 20, rules: [{ activity: "parking", user_classes: ["resident permit"] }], time_spans: [] },
    sweep: { curb_policy_id: "sweep", priority: 1, rules: [{ activity: "no parking", purposes: ["street cleaning"] }], time_spans: [{ days_of_week: ["tue"], time_of_day_start: "08:00", time_of_day_end: "12:00" }] },
    nostop: { curb_policy_id: "nostop", priority: 0, rules: [{ activity: "no stopping" }], time_spans: [] },
    noprio: { curb_policy_id: "noprio", rules: [{ activity: "loading" }], time_spans: [] },
  };
  const z = (ids) => ({ curb_policy_ids: ids });

  it("lowest priority number wins among active policies", () => {
    expect(verdict(z(["meter", "rpp", "sweep"]), policies, "tue", M(9)).category).toBe("street_cleaning");
    expect(verdict(z(["meter", "rpp", "sweep"]), policies, "tue", M(14)).category).toBe("paid");
    expect(verdict(z(["meter", "rpp", "sweep"]), policies, "sun", M(22)).category).toBe("resident");
  });
  it("priority 0 is valid and beats everything", () => {
    expect(verdict(z(["meter", "nostop"]), policies, "mon", M(12)).category).toBe("no_stopping");
  });
  it("policy without priority ranks last", () => {
    expect(verdict(z(["noprio", "rpp"]), policies, "mon", M(12)).category).toBe("resident");
    expect(verdict(z(["noprio"]), policies, "mon", M(12)).category).toBe("loading");
  });
  it("returns unknown when nothing is active or policy missing", () => {
    expect(verdict(z(["sweep"]), policies, "mon", M(12)).category).toBe("unknown");
    expect(verdict(z(["ghost"]), policies, "mon", M(12)).category).toBe("unknown");
    expect(verdict(z([]), policies, "mon", M(12)).category).toBe("unknown");
    expect(verdict({}, policies, "mon", M(12)).category).toBe("unknown");
  });
  it("ignores survey placeholders like 'unusable image' so real rules underneath win", () => {
    const pols = { ...policies, junk: { curb_policy_id: "junk", priority: 0, rules: [{ activity: "unusable image" }], time_spans: [] } };
    expect(verdict(z(["junk"]), pols, "mon", M(12)).category).toBe("unknown");
    expect(verdict(z(["junk", "rpp"]), pols, "mon", M(12)).category).toBe("resident");
  });
  it("reads 'no parking except resident_permit' as permit parking", () => {
    expect(categorize({ activity: "no parking", user_classes_except: ["resident_permit"] })).toBe("resident");
    expect(categorize({ activity: "no parking", user_classes_except: ["accessible"] })).toBe("accessible");
    expect(categorize({ activity: "no stopping", user_classes_except: ["commercial_vehicle"] })).toBe("loading");
    expect(categorize({ activity: "no parking", user_classes_except: ["valet"] })).toBe("no_parking");
  });
  it("uses policy-level rates (how the Boston feed stores meter prices)", () => {
    const pols = { m: { curb_policy_id: "m", priority: 1, rates: [{ rate: 200, rate_unit: "hour" }], rules: [{ activity: "parking", max_stay: 120 }], time_spans: [] } };
    const v = verdict(z(["m"]), pols, "mon", M(12));
    expect(v.category).toBe("paid");
    expect(fmtRate(v.rule)).toBe("$2.00 / hour");
  });
  describe("city meters: free Sundays, City holidays and outside meter hours — other rules still enforced", () => {
    it("a meter is paid in its hours and free on Sunday", () => {
      expect(verdict(z(["meter"]), policies, "mon", M(12)).category).toBe("paid");
      const sun = verdict(z(["meter"]), policies, "sun", M(12));
      expect(sun.category).toBe("free");
      expect(sun.meterFree).toBe(true);
    });
    it("a meter is free outside its posted hours", () => {
      expect(verdict(z(["meter"]), policies, "mon", M(21)).category).toBe("free");
    });
    it("holidays: the caller flags meterFree", () => {
      expect(verdict(z(["meter"]), policies, "wed", M(12), { meterFree: true }).category).toBe("free");
    });
    it("free-meter never beats another active rule, whatever its priority", () => {
      expect(verdict(z(["meter", "rpp"]), policies, "sun", M(12)).category).toBe("resident"); // meter p10 < rpp p20
      expect(verdict(z(["meter", "rpp"]), policies, "mon", M(21)).category).toBe("resident");
      expect(verdict(z(["meter", "sweep"]), { ...policies, sweep: { ...policies.sweep, time_spans: [{ days_of_week: ["sun"], time_of_day_start: "08:00", time_of_day_end: "12:00" }] } }, "sun", M(9)).category).toBe("street_cleaning");
    });
  });
  it("exposes the winning policy and rule", () => {
    const v = verdict(z(["meter", "rpp"]), policies, "mon", M(12));
    expect(v.policy.curb_policy_id).toBe("meter");
    expect(v.rule.max_stay).toBe(120);
  });
});

describe("formatters", () => {
  it("fmtRate converts cents to dollars", () => {
    expect(fmtRate({ rate: [{ rate: 375, rate_unit: "hour" }] })).toBe("$3.75 / hour");
    expect(fmtRate({ rate: [{ rate: 50, rate_unit: "minute", rate_unit_period: 15 }] })).toBe("$0.50 / 15 minute");
    expect(fmtRate({ rates: [{ rate: 100 }] })).toBe("$1.00 / hour");
    expect(fmtRate({})).toBeNull();
  });
  it("fmtSpan prints days and hours", () => {
    expect(fmtSpan(span())).toBe("Mon–Sat, 8 AM–8 PM");
    expect(fmtSpan({ time_of_day_start: "18:00" })).toBe("Every day, 6 PM–12 AM");
    expect(fmtSpan({ days_of_week: ["mon", "wed", "fri"], time_of_day_start: "07:30", time_of_day_end: "12:00" })).toBe("Mon, Wed, Fri, 7:30 AM–12 PM");
    expect(fmtSpan({ days_of_week: ["sat", "sun"], time_of_day_start: "00:00", time_of_day_end: "00:00" })).toBe("Sat, Sun, all day");
    expect(fmtSpan({})).toBe("Every day, all day");
    expect(fmtSpan({ days_of_week: ["tue"], weeks_of_month: [1, 3], months: [4, 5, 6, 7, 8, 9, 10, 11], time_of_day_start: "08:00", time_of_day_end: "12:00" })).toBe("1st & 3rd Tue of the month, 8 AM–12 PM (Apr–Nov)");
    expect(fmtSpan({ designated_period: '{"snow emergency"}', time_of_day_start: "00:00", time_of_day_end: "00:00" })).toBe("Only during snow emergency: Every day, all day");
    expect(fmtSpan(null)).toBe("Every day, all day");
  });
  it("City holidays match boston.gov's 2026 list (actual dates, not observed)", () => {
    expect(cityHolidays(2026)).toEqual({
      "2026-01-01": "New Year's Day", "2026-01-19": "Martin Luther King Jr. Day", "2026-02-16": "Presidents Day",
      "2026-03-17": "Evacuation Day", "2026-04-20": "Patriots Day", "2026-05-25": "Memorial Day", "2026-06-17": "Bunker Hill Day",
      "2026-06-19": "Juneteenth", "2026-07-04": "Independence Day", "2026-09-07": "Labor Day", "2026-10-12": "Indigenous Peoples Day",
      "2026-11-11": "Veterans Day", "2026-11-26": "Thanksgiving", "2026-12-25": "Christmas Day",
    });
    expect(cityHoliday(new Date(2026, 6, 3))).toBeNull(); // meters are NOT free on the observed Friday
    expect(cityHoliday(new Date(2025, 10, 27))).toBe("Thanksgiving");
  });
  it("nextDate maps a weekday to its next occurrence, counting today", () => {
    const sat = new Date("2026-10-31T15:00:00");
    expect(nextDate("sat", sat).toDateString()).toBe("Sat Oct 31 2026");
    expect(nextDate("wed", sat).toDateString()).toBe("Wed Nov 04 2026");
    expect(nextDate("fri", sat).toDateString()).toBe("Fri Nov 06 2026");
  });
  it("dayKey maps JS getDay to keys", () => {
    expect(dayKey(new Date("2026-10-31T12:00:00"))).toBe("sat");
    expect(dayKey(new Date("2026-11-01T12:00:00"))).toBe("sun");
  });
});

describe("overnight spans belong to the day they start", () => {
  const s = { days_of_week: ["mon", "tue", "wed", "thu", "fri"], time_of_day_start: "18:00", time_of_day_end: "08:00" };
  it("Fri 6 PM → Sat 8 AM is in force", () => {
    expect(spanActive(s, "fri", M(19))).toBe(true);
    expect(spanActive(s, "sat", M(7))).toBe(true);
  });
  it("Sun night → Mon morning is not", () => {
    expect(spanActive(s, "sun", M(19))).toBe(false);
    expect(spanActive(s, "mon", M(7))).toBe(false);
    expect(spanActive(s, "mon", M(19))).toBe(true);
  });
});

describe("ruleOf normalizes time limits to minutes", () => {
  it("hours → minutes", () => {
    expect(ruleOf({ rules: [{ activity: "parking", max_stay: 2, max_stay_unit: "hour" }] }).max_stay).toBe(120);
    expect(ruleOf({ rules: [{ activity: "parking", max_stay: 30, max_stay_unit: "minute" }] }).max_stay).toBe(30);
  });
});

// The example zone: metered 8 AM–6 PM Mon–Sat (2-hour limit), resident permit 6 PM–8 AM Mon–Fri.
const EX = {
  meter: { curb_policy_id: "meter", priority: 83, rates: [{ rate: 375, rate_unit: "hour" }], rules: [{ activity: "parking", max_stay: 120, max_stay_unit: "minute" }],
    time_spans: [{ days_of_week: ["mon", "tue", "wed", "thu", "fri", "sat"], time_of_day_start: "08:00", time_of_day_end: "18:00" }] },
  rpp: { curb_policy_id: "rpp", priority: 73, rules: [{ activity: "no parking", user_classes_except: ["resident_permit"] }],
    time_spans: [{ days_of_week: ["mon", "tue", "wed", "thu", "fri"], time_of_day_start: "18:00", time_of_day_end: "08:00" }] },
};
const exZone = { curb_policy_ids: ["meter", "rpp"] };
const at = (iso) => new Date(iso);

describe("multiple rules on one curb (meter by day, resident permit by night)", () => {
  const cat = (d, h, m = 0) => verdict(exZone, EX, d, M(h, m)).category;
  it("each rule in its own hours", () => {
    expect(cat("tue", 10)).toBe("paid");
    expect(cat("tue", 19)).toBe("resident");
    expect(cat("wed", 7)).toBe("resident"); // Tue-night span still running
    expect(cat("sat", 7)).toBe("resident"); // Fri-night span runs into Saturday morning
  });
  it("the gaps between them are free", () => {
    expect(cat("sat", 19)).toBe("free");   // after the meter, no resident rule on Saturday nights
    expect(cat("sun", 12)).toBe("free");   // meters free on Sunday
    expect(cat("mon", 7)).toBe("free");    // Sunday night isn't a resident night
  });
});

describe("evaluateStay", () => {
  const stay = (iso, min, profile) => evaluateStay(exZone, EX, stayWindow(at(iso), min), profile);
  it("Sat 5–7 PM: paid until 6, then free → gets better at 6", () => {
    const r = stay("2026-10-31T17:00:00", 120);
    expect(r.fit).toBe("better");
    expect(r.at.getHours()).toBe(18);
    expect(r.worst).toBe("paid");
    expect(r.timeline.map((t) => t.cat)).toEqual(["paid", "free"]);
  });
  it("Tue 5–7 PM without a permit: resident-only from 6 → doesn't last", () => {
    const r = stay("2026-11-03T17:00:00", 120);
    expect(r.fit).toBe("breaks");
    expect(r.reason).toMatchObject({ kind: "rule", cat: "resident" });
    expect(r.at.getHours()).toBe(18);
  });
  it("…with a resident permit it works, and the permit hours count as better than the meter", () => {
    expect(stay("2026-11-03T17:00:00", 120, { permit: true }).fit).toBe("better");
  });
  it("Tue 9 AM for 3 hours: the 2-hour meter limit runs out at 11", () => {
    const r = stay("2026-11-03T09:00:00", 180);
    expect(r.fit).toBe("breaks");
    expect(r.reason).toMatchObject({ kind: "limit", max: 120 });
    expect(r.at.getHours()).toBe(11);
  });
  it("Sat 5–8 PM: the limit stops mattering when the meter ends at 6", () => {
    expect(stay("2026-10-31T17:00:00", 180).fit).toBe("better");
  });
  it("Sunday all afternoon: free throughout → works", () => {
    const r = stay("2026-11-01T12:00:00", 240);
    expect(r.fit).toBe("ok");
    expect(r.worst).toBe("free");
  });
  it("Tue 8 PM without a permit: not allowed at the start", () => {
    expect(stay("2026-11-03T20:00:00", 60).fit).toBe("no");
  });
  it("a City holiday frees the meter all day (Veterans Day, Wed Nov 11 2026)", () => {
    expect(stay("2026-11-11T10:00:00", 180).fit).toBe("ok");
  });
  it("steps are 30 minutes and a stay can cross midnight", () => {
    const w = stayWindow(at("2026-10-31T23:00:00"), 120);
    expect(w).toHaveLength(4);
    expect(w.map((s) => s.day)).toEqual(["sat", "sat", "sun", "sun"]);
  });
});

describe("street cleaning", () => {
  // The curb feed's way of writing it: no parking, 1st & 3rd Tue, 8 AM–12 PM, April–November.
  const sweep = { curb_policy_id: "sw", priority: 2, rules: [{ activity: "no parking" }],
    time_spans: [{ days_of_week: ["tue"], weeks_of_month: [1, 3], months: [4, 5, 6, 7, 8, 9, 10, 11], time_of_day_start: "08:00", time_of_day_end: "12:00" }] };
  const free = { curb_policy_id: "fr", priority: 50, rules: [{ activity: "parking" }], time_spans: [] };
  const pols = { sw: sweep, fr: free }, zone = { curb_policy_ids: ["sw", "fr"] };
  it("is recognized from week/month-limited no-parking rules or an explicit purpose", () => {
    expect(isStreetCleaning(sweep)).toBe(true);
    expect(isStreetCleaning({ rules: [{ activity: "no parking", purposes: ["street_cleaning"] }], time_spans: [] })).toBe(true);
    expect(isStreetCleaning({ rules: [{ activity: "no parking" }], time_spans: [{ days_of_week: ["tue"] }] })).toBe(false);
    expect(isStreetCleaning(free)).toBe(false);
  });
  it("on a real date only the listed weeks count (1st & 3rd Tue of Nov 2026 = Nov 3 and 17)", () => {
    const at = (iso) => { const d = new Date(iso); return verdict(zone, pols, dayKey(d), d.getHours() * 60, { date: d }).category; };
    expect(at("2026-11-03T09:00:00")).toBe("street_cleaning");
    expect(at("2026-11-10T09:00:00")).toBe("free");   // 2nd Tuesday
    expect(at("2026-11-17T09:00:00")).toBe("street_cleaning");
    expect(at("2026-12-01T09:00:00")).toBe("free");   // December: out of season
  });
  it("in the generic week (no date) it may apply on any listed weekday", () => {
    const yearRound = { ...pols, sw: { ...sweep, time_spans: [{ ...sweep.time_spans[0], months: null }] } }; // no season → no dependence on today
    expect(verdict(zone, yearRound, "tue", M(9)).category).toBe("street_cleaning");
  });
  it("a stay over a sweeping window doesn't last", () => {
    const r = evaluateStay(zone, pols, stayWindow(new Date("2026-11-03T07:00:00"), 180));
    expect(r.fit).toBe("breaks");
    expect(r.reason.cat).toBe("street_cleaning");
    expect(r.at.getHours()).toBe(8);
  });
});

describe("collapsePolicies", () => {
  const sweep = (id, days, start = "00:01", end = "07:00", extra = {}) => ({ curb_policy_id: id, priority: 2, rules: [{ activity: "no parking", purposes: ["street_cleaning"] }], time_spans: [{ days_of_week: days, time_of_day_start: start, time_of_day_end: end, ...extra }] });
  const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  it("folds a repeated rule and a narrower copy (Wed inside every day) into one", () => {
    const a = sweep("a", ALL), wed = sweep("w", ["wed"]), b = sweep("b", ALL);
    const out = collapsePolicies([a, wed, b]);
    expect(out).toHaveLength(1);
    expect(out[0].policy).toBe(a);
    expect(out[0].absorbed).toEqual([wed, b]);
  });
  it("a broader copy listed later replaces the narrower one listed first", () => {
    const wed = sweep("w", ["wed"]), a = sweep("a", ALL);
    const out = collapsePolicies([wed, a]);
    expect(out.map((o) => o.policy)).toEqual([a]);
    expect(out[0].absorbed).toEqual([wed]);
  });
  it("keeps copies whose times aren't covered, or that are different rules", () => {
    const morning = sweep("m", ALL), evening = sweep("e", ["wed"], "18:00", "20:00");
    const weekly = sweep("x", ["wed"], "00:01", "07:00", { weeks_of_month: [1, 3] });
    const tow = { ...sweep("t", ["wed"]), rules: [{ activity: "no stopping" }] };
    expect(collapsePolicies([evening, morning])).toHaveLength(2);
    expect(collapsePolicies([weekly, morning])).toHaveLength(1); // 1st & 3rd Wed is inside every day
    expect(collapsePolicies([morning, weekly]).at(0).absorbed).toEqual([weekly]);
    expect(collapsePolicies([morning, tow])).toHaveLength(2);
    expect(collapsePolicies([sweep("a", ALL, "00:01", "07:00", { months: [4, 5] }), sweep("b", ["wed"])])).toHaveLength(2); // Apr–May doesn't cover all year
  });
  it("a rule with no time spans (always) covers any copy of itself", () => {
    const always = { ...sweep("a", ALL), time_spans: [] };
    expect(collapsePolicies([always, sweep("w", ["wed"])])).toHaveLength(1);
  });
});

describe("overriddenBy", () => {
  const P = (id, priority, activity, spans, extra = {}) => ({ curb_policy_id: id, priority, rules: [{ activity, ...extra }], time_spans: spans });
  const hydrant = P("h", 1, "no stopping", []);
  const parking = P("p", 30, "parking", [{ days_of_week: ["mon", "tue", "wed", "thu", "fri"], time_of_day_start: "08:00", time_of_day_end: "18:00" }], { max_stay: 120 });
  const sweep = P("s", 2, "no parking", [{ days_of_week: ["wed"], weeks_of_month: [1, 3], time_of_day_start: "08:00", time_of_day_end: "12:00" }], { purposes: ["street_cleaning"] });
  it("an all-day no-stopping of higher precedence overrides parking and sweeping on the same curb", () => {
    expect(overriddenBy(parking, [hydrant, parking, sweep])).toBe(hydrant);
    expect(overriddenBy(sweep, [hydrant, parking, sweep])).toBe(hydrant);
    expect(overriddenBy(hydrant, [hydrant, parking, sweep])).toBeNull();
  });
  it("needs higher precedence and full time coverage", () => {
    const lowNo = P("l", 50, "no stopping", []);
    expect(overriddenBy(parking, [lowNo, parking])).toBeNull(); // the parking rule wins over it
    const rushHour = P("r", 1, "no stopping", [{ days_of_week: ["mon", "tue", "wed", "thu", "fri"], time_of_day_start: "16:00", time_of_day_end: "18:00" }]);
    expect(overriddenBy(parking, [rushHour, parking])).toBeNull(); // parking still applies 8 AM–4 PM
  });
  it("a snow-emergency rule doesn't override anything, but is itself overridden by an always-on one", () => {
    const snow = P("x", 1, "no parking", [{ time_of_day_start: "00:00", time_of_day_end: "00:00", designated_period: "snow emergency" }]);
    expect(overriddenBy(parking, [snow, parking])).toBeNull();
    expect(overriddenBy({ ...snow, priority: 33 }, [hydrant, { ...snow, priority: 33 }])).toBe(hydrant);
  });
  it("meters don't override (they go free on Sundays and after hours)", () => {
    const meter = P("m", 1, "parking", [], { rate: [{ rate: 1.25 }] });
    expect(overriddenBy(P("n", 9, "no parking", []), [meter])).toBeNull();
  });
});

describe("meter vs. time-limit sign on the same curb", () => {
  const span = [{ days_of_week: ["mon", "tue", "wed", "thu", "fri", "sat"], time_of_day_start: "08:00", time_of_day_end: "20:00" }];
  const sign = { curb_policy_id: "sign", priority: 5, rules: [{ activity: "parking", max_stay: 120 }], time_spans: span };
  const meter = { curb_policy_id: "meter", priority: 9, rules: [{ activity: "parking", max_stay: 120, rate: [{ rate: 3.75 }] }], time_spans: span };
  const zone = { curb_policy_ids: ["sign", "meter"] }, pols = { sign, meter };
  it("the meter applies while it runs, even when the sign has precedence in the feed", () => {
    expect(verdict(zone, pols, "mon", 10 * 60).category).toBe("paid");
    expect(verdict(zone, pols, "mon", 10 * 60).policy).toBe(meter);
  });
  it("on Sundays the meter is free and the sign's time limit is what's left", () => {
    expect(verdict(zone, pols, "sun", 10 * 60).category).toBe("free");
  });
  it("the sign doesn't count as overriding the meter", () => {
    expect(overriddenBy(meter, [sign, meter])).toBeNull();
  });
});

describe("accessible and resident-permit rules on the same stretch", () => {
  const allDay = [{ days_of_week: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], time_of_day_start: "00:00", time_of_day_end: "00:00" }];
  const acc = { curb_policy_id: "acc", priority: 73, rules: [{ activity: "no parking", user_classes_except: ["accessible"] }], time_spans: allDay };
  const res = { curb_policy_id: "res", priority: 53, rules: [{ activity: "no parking", user_classes_except: ["resident_permit"] }], time_spans: allDay };
  const both = { curb_policy_id: "both", priority: 73, rules: [{ activity: "no parking", user_classes_except: ["accessible", "resident_permit"] }], time_spans: allDay };
  const pols = { acc, res, both };
  it("two separate rules in force together grade as needing both, whatever their priorities", () => {
    expect(verdict({ curb_policy_ids: ["res", "acc"] }, pols, "mon", 600).category).toBe("accessible_permit");
    expect(verdict({ curb_policy_ids: ["acc", "res"] }, { acc, res: { ...res, priority: 73 } }, "mon", 600).category).toBe("accessible_permit");
    expect(allowedFor("accessible_permit", { placard: true })).toBe(false);
    expect(allowedFor("accessible_permit", { permit: true })).toBe(false);
    expect(allowedFor("accessible_permit", { placard: true, permit: true })).toBe(true);
  });
  it("one rule that lists both exceptions itself is still either-or", () => {
    expect(verdict({ curb_policy_ids: ["both"] }, pols, "mon", 600).category).toBe("resident");
  });
  it("an accessible rule is never folded away as overridden, and never folds others", () => {
    expect(overriddenBy(acc, [res, acc])).toBeNull();
    expect(overriddenBy({ ...res, priority: 90 }, [{ ...acc, priority: 1 }])).toBeNull();
  });
});
