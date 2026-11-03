// Community submissions: the rule cards people edit, how they become CDS-style policies (the same shape as the city
// feed, so the build merges them like any other source), and the validation the API applies before storing them.
// Shared by the browser (editor), the API (api/submit.js) and the build (scripts/community.js).
import { categorize, isStreetCleaning, ruleOf, designatedPeriods } from "./rules.js";

// The rule types the editor offers, most restrictive first. `priority` follows the feed's convention (lower wins).
export const RULE_TYPES = {
  no_stopping:     { label: "No stopping",          activity: "no stopping", priority: 10 },
  travel:          { label: "Tow-away / travel lane", activity: "travel", priority: 12 },
  street_cleaning: { label: "Street cleaning",      activity: "no parking", purposes: ["street cleaning"], weeks: true, months: true, priority: 15 },
  no_parking:      { label: "No parking",           activity: "no parking", priority: 20 },
  loading:         { label: "Loading zone",         activity: "loading", limit: true, priority: 30 },
  accessible:      { label: "Accessible (placard) only", activity: "parking", classes: ["disability_placard"], priority: 35 },
  resident:        { label: "Resident permit only", activity: "parking", classes: ["resident_permit"], priority: 40 },
  paid:            { label: "Paid meter",           activity: "parking", limit: true, rate: true, priority: 80 },
  free:            { label: "Free parking",         activity: "parking", limit: true, priority: 90 },
};
export const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const LIMITS = [15, 30, 60, 120, 180, 240, 600]; // minutes; null = no limit
export const MAX_RULES = 12;

// A card: { type, days, allDay, start, end, limit, rate, weeks, months: [from, to] | null }
export const newCard = (type = "paid") => ({ type, days: WEEK.slice(0, 6), allDay: false, start: "08:00", end: "18:00", limit: type === "paid" ? 120 : null, rate: null, weeks: [], months: null });

const monthList = ([a, b]) => { const out = []; for (let m = a; ; m = (m % 12) + 1) { out.push(m); if (m === b) break; } return out; };
export function cardToPolicy(card, id) {
  const t = RULE_TYPES[card.type];
  const span = {
    days_of_week: [...card.days],
    time_of_day_start: card.allDay ? "00:00" : card.start,
    time_of_day_end: card.allDay ? "00:00" : card.end,
    ...(t.weeks && card.weeks?.length && card.weeks.length < 5 ? { weeks_of_month: [...card.weeks] } : {}),
    ...(t.months && card.months ? { months: monthList(card.months) } : {}),
  };
  return {
    curb_policy_id: id, priority: t.priority, description: t.label,
    rules: [{
      activity: t.activity,
      ...(t.limit && card.limit ? { max_stay: card.limit, max_stay_unit: "minute" } : {}),
      ...(t.classes ? { user_classes: [...t.classes] } : {}),
      ...(t.purposes ? { purposes: [...t.purposes] } : {}),
    }],
    ...(t.rate ? { rates: [{ rate: card.rate != null && card.rate !== "" ? Math.round(+card.rate * 100) : null, rate_unit: "hour" }] } : {}),
    time_spans: [span],
  };
}

// Back from a policy (the city's, a meter's, a previous submission) to cards, one per time span. Rules the editor
// can't express (bus only, valet, …) and event-only spans (snow emergencies) are left out.
export function policyToCards(p) {
  const rule = ruleOf(p), cat = isStreetCleaning(p) ? "street_cleaning" : categorize(rule);
  if (!RULE_TYPES[cat]) return [];
  const rate = (rule.rate || rule.rates || [])[0]?.rate;
  const spans = (p.time_spans?.length ? p.time_spans : [{}]).filter((s) => !designatedPeriods(s.designated_period).length);
  return spans.map((s) => {
    const a = s.time_of_day_start, b = s.time_of_day_end;
    const allDay = (!a && !b) || a === b;
    const months = s.months?.length && s.months.length < 12 ? [s.months[0], s.months[s.months.length - 1]] : null;
    return {
      type: cat,
      days: s.days_of_week?.length ? WEEK.filter((d) => s.days_of_week.map((x) => x.toLowerCase().slice(0, 3)).includes(d)) : [...WEEK],
      allDay, start: allDay ? "08:00" : (a === "00:01" ? "00:00" : a || "00:00"), end: allDay ? "18:00" : (b === "24:00" ? "24:00" : b || "24:00"),
      limit: rule.max_stay || null, rate: rate != null ? rate / 100 : null,
      weeks: s.weeks_of_month?.length && s.weeks_of_month.length < 5 ? [...s.weeks_of_month] : [], months,
    };
  });
}

// The cards for a curb's current rules. On a metered curb, free-parking signs are implied (the meter's time limit, and
// free outside its hours), so they're left out rather than shown as rules of their own.
export function cardsFor(policies) {
  const cards = policies.flatMap(policyToCards);
  return cards.some((c) => c.type === "paid") ? cards.filter((c) => c.type !== "free") : cards;
}

// ---------- validation (API) ----------
// Returns a cleaned copy holding only the fields the build reads, or throws an Error with a reason.
const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const ACTIVITIES = new Set(Object.values(RULE_TYPES).map((t) => t.activity));
const CLASSES = new Set(["resident_permit", "disability_placard"]);
const PURPOSES = new Set(["street cleaning"]);
export function validateRules(rules) {
  if (!Array.isArray(rules) || !rules.length) throw new Error("at least one rule is needed");
  if (rules.length > MAX_RULES) throw new Error(`at most ${MAX_RULES} rules`);
  return rules.map((p, i) => {
    const r = p?.rules?.[0];
    if (!r || !ACTIVITIES.has(r.activity)) throw new Error(`rule ${i + 1}: unknown kind`);
    if (!Number.isInteger(p.priority) || p.priority < 1 || p.priority > 1000) throw new Error(`rule ${i + 1}: bad priority`);
    const spans = p.time_spans;
    if (!Array.isArray(spans) || !spans.length || spans.length > 4) throw new Error(`rule ${i + 1}: needs 1–4 time spans`);
    const cleanSpans = spans.map((s) => {
      const days = s.days_of_week;
      if (!Array.isArray(days) || !days.length || days.some((d) => !WEEK.includes(d))) throw new Error(`rule ${i + 1}: pick at least one day`);
      if (!TIME.test(s.time_of_day_start) || !TIME.test(s.time_of_day_end)) throw new Error(`rule ${i + 1}: bad time`);
      const weeks = s.weeks_of_month, months = s.months;
      if (weeks != null && (!Array.isArray(weeks) || weeks.some((w) => !Number.isInteger(w) || w < 1 || w > 5))) throw new Error(`rule ${i + 1}: bad weeks`);
      if (months != null && (!Array.isArray(months) || months.some((m) => !Number.isInteger(m) || m < 1 || m > 12))) throw new Error(`rule ${i + 1}: bad months`);
      return { days_of_week: [...new Set(days)], time_of_day_start: s.time_of_day_start, time_of_day_end: s.time_of_day_end, ...(weeks?.length ? { weeks_of_month: weeks } : {}), ...(months?.length ? { months } : {}) };
    });
    const max = r.max_stay;
    if (max != null && (!Number.isInteger(max) || max < 1 || max > 1440)) throw new Error(`rule ${i + 1}: bad time limit`);
    if (r.user_classes != null && (!Array.isArray(r.user_classes) || r.user_classes.some((c) => !CLASSES.has(c)))) throw new Error(`rule ${i + 1}: bad user class`);
    if (r.purposes != null && (!Array.isArray(r.purposes) || r.purposes.some((c) => !PURPOSES.has(c)))) throw new Error(`rule ${i + 1}: bad purpose`);
    const rates = p.rates;
    if (rates != null && (!Array.isArray(rates) || rates.length !== 1 || (rates[0].rate != null && (!Number.isInteger(rates[0].rate) || rates[0].rate < 0 || rates[0].rate > 10000)))) throw new Error(`rule ${i + 1}: bad rate`);
    return {
      priority: p.priority, description: String(p.description || "").slice(0, 80),
      rules: [{ activity: r.activity, ...(max ? { max_stay: max, max_stay_unit: "minute" } : {}), ...(r.user_classes?.length ? { user_classes: r.user_classes } : {}), ...(r.purposes?.length ? { purposes: r.purposes } : {}) }],
      ...(rates ? { rates: [{ rate: rates[0].rate ?? null, rate_unit: "hour" }] } : {}),
      time_spans: cleanSpans,
    };
  });
}
