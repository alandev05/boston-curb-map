import { describe, it, expect } from "vitest";
import { spanActive, policyActive, categorize, verdict, fmtRate, fmtSpan, dayKey, CATEGORIES } from "../src/rules.js";

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
    expect(verdict(z(["meter", "rpp", "sweep"]), policies, "tue", M(9)).category).toBe("no_parking");
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
    expect(verdict(z(["meter"]), policies, "sun", M(12)).category).toBe("unknown");
    expect(verdict(z(["ghost"]), policies, "mon", M(12)).category).toBe("unknown");
    expect(verdict(z([]), policies, "mon", M(12)).category).toBe("unknown");
    expect(verdict({}, policies, "mon", M(12)).category).toBe("unknown");
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
    expect(fmtSpan(span())).toBe("mon tue wed thu fri sat 08:00–20:00");
    expect(fmtSpan({ time_of_day_start: "18:00" })).toBe("daily 18:00–24:00");
    expect(fmtSpan({})).toBe("daily");
    expect(fmtSpan(null)).toBe("always");
  });
  it("dayKey maps JS getDay to keys", () => {
    expect(dayKey(new Date("2026-10-31T12:00:00"))).toBe("sat");
    expect(dayKey(new Date("2026-11-01T12:00:00"))).toBe("sun");
  });
});
