// Turn CDS policies into a single "what applies at this moment" verdict per zone.
// CDS Curbs spec: https://github.com/openmobilityfoundation/curb-data-specification/tree/main/curbs

// Flat, even-weight colors per theme (light = deep tones for a light basemap, dark = soft tones for a dark one),
// in the spirit of Google Maps' palette: no neon, no glow, every category equally legible.
export const CATEGORIES = {
  no_stopping: { label: "No stopping", light: "#d93025", dark: "#f28b82" },
  no_parking:  { label: "No parking",  light: "#e8710a", dark: "#fcad70" },
  street_cleaning: { label: "Street cleaning", light: "#12a4b8", dark: "#78d9ec" },
  travel:      { label: "Travel lane", light: "#5f6368", dark: "#bdc1c6" },
  loading:     { label: "Loading zone", light: "#e3a008", dark: "#fdd663" },
  paid:        { label: "Paid meter", light: "#1a73e8", dark: "#8ab4f8" },
  resident:    { label: "Resident permit", light: "#9334e6", dark: "#c58af9" },
  accessible:  { label: "Accessible", light: "#d01884", dark: "#ff8bcb" },
  // An accessible-only rule and a resident-only rule posted on the same short stretch (689 curbs, median 17 m): the
  // feed doesn't say whether you need either or both, so it's graded strictly (both). Shown under "Accessible".
  accessible_permit: { label: "Accessible + permit", light: "#d01884", dark: "#ff8bcb", blurb: "Accessible space and resident permit both posted. Check the sign.", legend: false },
  free:        { label: "Free / time-limit", light: "#188038", dark: "#81c995" },
  unknown:     { label: "No data", light: "#9aa0a6", dark: "#80868b", blurb: "No sign data for this curb. Check the posted sign." },
};

// Hover/selected shade: darker on the light map, lighter on the dark one (how Google highlights a route).
export function shade(hex, theme) {
  const t = theme === "light" ? 0.32 : 0.4, to = theme === "light" ? 0 : 255;
  const n = parseInt(hex.slice(1), 16);
  return "#" + [16, 8, 0].map((sh) => Math.round(((n >> sh) & 255) * (1 - t) + to * t).toString(16).padStart(2, "0")).join("");
}
export const catColor = (k, theme) => (CATEGORIES[k] || CATEGORIES.unknown)[theme === "light" ? "light" : "dark"];

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function minutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + (m || 0);
}
// Why a curb is no stopping / no parking, when the city's description says (the structured rule doesn't):
// "* No Stopping Fire Hydrant" → "fire hydrant". The build stores it as `reason` (the bundle drops descriptions).
const REASONS = /^\*?\s*No (?:Stopping|Parking) (Fire Hydrant|Bus Stop|Emergency Use)\b/im;
export const reasonOf = (pol) => pol.reason ?? pol.description?.match(REASONS)?.[1].toLowerCase() ?? null;
// Signs say "12:01 AM" to mean "from midnight" (12:00 AM would be ambiguous about which day). Grading a :01 start as
// :00 keeps those rules in force at the top of the hour, which is what the slider lands on. Display keeps "12:01 AM".
function startMinutes(hhmm) {
  const m = minutes(hhmm);
  return m != null && m % 60 === 1 ? m - 1 : m;
}

// The feed stores designated periods as Postgres array literals: '{"snow emergency"}', '{holidays}'.
export function designatedPeriods(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : String(v).replace(/^\{|\}$/g, "").split(",");
  return list.map((x) => String(x).replace(/"/g, "").trim().toLowerCase()).filter(Boolean);
}
// Periods that only exist when the city declares them. Under normal conditions those rules are off.
const EVENT_PERIODS = /snow|game|event|holiday|emergency/;

// Does a CDS time_span cover (day, minute-of-day)?
// weeks_of_month (street cleaning on the 1st & 3rd Tue) needs a real date: with `exact` (a specific day is being
// looked at) the nth-weekday-of-the-month is checked; for the generic weekly schedule it isn't, so such rules count
// as "may be in force" on that weekday.
// Overnight spans ("Mon–Fri 6 PM–8 AM") belong to the day they start: Friday 6 PM through Saturday 8 AM is in force,
// Sunday night into Monday morning is not. So after midnight the previous day is the one checked against the list.
export function spanActive(span, day, minute, today = new Date(), exact = false) {
  if (!span) return true;
  if (designatedPeriods(span.designated_period).some((d) => EVENT_PERIODS.test(d))) return false;
  if (span.months?.length && !span.months.includes(today.getMonth() + 1)) return false;
  if (exact && span.weeks_of_month?.length && span.weeks_of_month.length < 5 && !span.weeks_of_month.includes(Math.ceil(today.getDate() / 7))) return false;
  const s = startMinutes(span.time_of_day_start), e = minutes(span.time_of_day_end);
  const startDay = s != null && e != null && s > e && minute < e ? DAYS[(DAYS.indexOf(day) + 6) % 7] : day;
  if (span.days_of_week?.length && !span.days_of_week.map((d) => d.toLowerCase().slice(0, 3)).includes(startDay)) return false;
  if (s != null && e != null && s === e) { /* 00:00–00:00 = all day */ }
  else if (s != null && e != null) {
    if (s <= e) { if (minute < s || minute >= e) return false; }
    else if (minute < s && minute >= e) return false; // overnight span
  } else if (s != null && minute < s) return false;
  else if (e != null && minute >= e) return false;
  // Date-bounded spans (e.g. seasonal street sweeping) — assume active if no dates or within.
  if (span.start_date && new Date(span.start_date) > today) return false;
  if (span.end_date && new Date(span.end_date) < today) return false;
  return true;
}

// Survey placeholders in the city feed (e.g. "unusable image": the sign photo couldn't be read). Not a rule.
const JUNK_ACTIVITY = /unusable|image|unknown|^$/i;
export function isRealPolicy(policy) {
  return !!policy && !JUNK_ACTIVITY.test(String((policy.rules || [])[0]?.activity || "").trim());
}

// `date`: the actual moment being looked at (exact months / weeks of the month); omitted for the generic week.
export function policyActive(policy, day, minute, date) {
  const spans = policy.time_spans || [];
  if (!spans.length) return true;
  return spans.some((s) => spanActive(s, day, minute, date || new Date(), !!date));
}

// Street cleaning: tagged as such, or a no-parking/no-stopping rule that only runs some weeks of the month or some
// months of the year (how the curb feed writes "No Parking 8 AM–12 PM, 1st & 3rd Tue, Apr–Nov").
export function isStreetCleaning(policy) {
  const rule = (policy?.rules || [])[0] || {};
  const act = String(rule.activity || "").toLowerCase().replace(/_/g, " ");
  if (/street.?clean|sweep/i.test((rule.purposes || []).join(" ") + " " + (policy.description || ""))) return true;
  if (act !== "no parking" && act !== "no stopping") return false;
  return (policy.time_spans || []).some((s) => (s.weeks_of_month?.length && s.weeks_of_month.length < 5) || (s.months?.length && s.months.length < 12));
}

const CLASS_HINTS = {
  resident: /resident|permit/i,
  accessible: /disab|handicap|accessib|ada/i,
  loading: /commercial|truck|freight|delivery/i,
};

// The policy's first rule, with policy-level rates folded in (Boston puts meter rates on the policy, not the rule).
// max_stay comes back in minutes whatever unit the feed used (40 Boston rules give hours).
export function ruleOf(policy) {
  const rule = (policy?.rules || [])[0] || {};
  const rate = rule.rate || rule.rates || policy?.rates;
  const out = rate?.length ? { ...rule, rate } : { ...rule };
  if (out.max_stay && /^h/i.test(out.max_stay_unit || "")) { out.max_stay *= 60; out.max_stay_unit = "minute"; }
  return out;
}

export function categorize(rule) {
  const activity = String(rule.activity || "").toLowerCase().replace(/_/g, " ");
  const classes = (rule.user_classes || []).join(" ");
  const except = (rule.user_classes_except || []).join(" ");
  const purposes = (rule.purposes || []).join(" ").toLowerCase();
  if (activity === "travel") return "travel";
  // "No parking except resident_permit" is how the feed spells permit-only parking.
  if (/^no (parking|stopping|standing)$/.test(activity) && except) {
    if (CLASS_HINTS.resident.test(except)) return "resident";
    if (CLASS_HINTS.accessible.test(except)) return "accessible";
    if (CLASS_HINTS.loading.test(except)) return "loading";
  }
  if (activity === "no stopping") return "no_stopping";
  if (activity === "no parking" || activity === "no standing") return "no_parking";
  if (activity === "loading" || activity === "unloading" || /loading/.test(purposes)) return "loading";
  if (CLASS_HINTS.accessible.test(classes)) return "accessible";
  if (CLASS_HINTS.resident.test(classes) || /resident|permit/.test(purposes)) return "resident";
  if (rule.rate?.length || rule.rates?.length) return "paid";
  if (CLASS_HINTS.loading.test(classes)) return "loading";
  if (activity === "parking" || activity === "stopping" || activity === "standing") return "free";
  return "unknown";
}

// Resolve the winning rule for a zone at (day, minute).
// CDS precedence: lower `priority` number wins when policies overlap.
//
// City meters: "On Sundays and City holidays you can park for free. But, all other parking regulations are still
// enforced." (boston.gov parking clerk). Outside its posted hours a meter likewise leaves the space free. So a metered
// policy competes at its own priority while it's charging (its hours, not Sunday/holiday); any other time it only
// says "free" as a last resort — every other active rule (street cleaning, resident-only, no stopping…) beats it.
// `meterFree` defaults to Sundays; the map passes it for City holidays too (see cityHoliday).
export const isMetered = (policy) => categorize(ruleOf(policy)) === "paid";

// What a policy is, independent of time (memoized per policy object: grading the whole city asks thousands of times).
const KIND = new WeakMap();
function kindOf(p) {
  let k = KIND.get(p);
  if (!k) { const rule = ruleOf(p); k = { real: isRealPolicy(p), metered: isMetered(p), rule, category: isStreetCleaning(p) ? "street_cleaning" : categorize(rule) }; KIND.set(p, k); }
  return k;
}
// `active` (optional): a Map, policy → active at this moment, shared across zones evaluated for the same moment.
export function verdict(zone, policies, day, minute, { meterFree = day === "sun", date, active: memo } = {}) {
  const ids = zone.curb_policy_ids || [];
  let best = null, meter = null, acc = null, res = null;
  for (const id of ids) {
    const p = policies[id];
    if (!p) continue;
    const k = kindOf(p);
    if (!k.real) continue;
    let active = memo?.get(p);
    if (active === undefined) { active = policyActive(p, day, minute, date); memo?.set(p, active); }
    if (!active && !k.metered) continue;
    const free = k.metered && (meterFree || !active);
    const pr = free ? Infinity : p.priority ?? 1000;
    if (!best || pr < best.pr) best = { pr, p, k, free };
    if (k.metered && !free && (!meter || pr < meter.pr)) meter = { pr, p, k, free };
    if (active && k.category === "accessible") acc ||= { pr, p, k, free: false };
    if (active && k.category === "resident") res ||= { pr, p, k, free: false };
  }
  // A time-limit sign and a meter on the same curb describe the same spaces ("2 hr parking" + "$3.75/hr, 2 hr max"):
  // while the meter runs, you pay, whichever the feed ranked first.
  if (best && meter && !best.free && best.k.category === "free") best = meter;
  // Accessible-only and resident-only rules in force together describe the same short stretch, not a contest won
  // on priority: graded as needing both (see CATEGORIES.accessible_permit).
  if (best && acc && res && (best.k.category === "accessible" || best.k.category === "resident"))
    return { category: "accessible_permit", rule: acc.k.rule, policy: acc.p, meterFree: false, also: res.p };
  if (!best) return { category: "unknown", rule: null, policy: null, meterFree: false };
  return { category: best.free ? "free" : best.k.category, rule: best.k.rule, policy: best.p, meterFree: best.free };
}

// The curb's day as consecutive blocks: [{ from, to, v }] in minutes (to ≤ 1440), v = verdict for that stretch.
// The verdict only changes where some rule starts or ends, so it's evaluated once per such boundary and equal
// neighbours (same category, rule and meter state) are merged.
export function daySchedule(zone, policies, day, date, { meterFree = day === "sun" } = {}) {
  const cuts = new Set([0]);
  for (const id of zone.curb_policy_ids || []) for (const s of policies[id]?.time_spans || []) {
    const a = startMinutes(s.time_of_day_start), b = minutes(s.time_of_day_end);
    if (a != null) cuts.add(a % 1440);
    if (b != null) cuts.add(b % 1440);
  }
  const at = [...cuts].sort((x, y) => x - y), blocks = [];
  at.forEach((from, i) => {
    const to = at[i + 1] ?? 1440, v = verdict(zone, policies, day, from, { meterFree, date });
    const last = blocks[blocks.length - 1];
    if (last && last.v.category === v.category && last.v.policy === v.policy && last.v.meterFree === v.meterFree) last.to = to;
    else blocks.push({ from, to, v });
  });
  return blocks;
}

// ---------- City of Boston holidays (meters free all day) ----------
// From boston.gov's City holidays list. Meters are free on the actual date, not the observed weekday
// (e.g. free Sat July 4, NOT Fri July 3); Juneteenth runs "Sunday parking rules".
const nth = (y, m, wd, n) => { const first = new Date(y, m, 1).getDay(); return 1 + ((wd - first + 7) % 7) + (n - 1) * 7; };
const lastMon = (y, m) => { const last = new Date(y, m + 1, 0); return last.getDate() - ((last.getDay() + 6) % 7); };
export function cityHolidays(y) {
  return {
    [`${y}-01-01`]: "New Year's Day",
    [`${y}-01-${String(nth(y, 0, 1, 3)).padStart(2, "0")}`]: "Martin Luther King Jr. Day",
    [`${y}-02-${String(nth(y, 1, 1, 3)).padStart(2, "0")}`]: "Presidents Day",
    [`${y}-03-17`]: "Evacuation Day",
    [`${y}-04-${String(nth(y, 3, 1, 3)).padStart(2, "0")}`]: "Patriots Day",
    [`${y}-05-${String(lastMon(y, 4)).padStart(2, "0")}`]: "Memorial Day",
    [`${y}-06-17`]: "Bunker Hill Day",
    [`${y}-06-19`]: "Juneteenth",
    [`${y}-07-04`]: "Independence Day",
    [`${y}-09-${String(nth(y, 8, 1, 1)).padStart(2, "0")}`]: "Labor Day",
    [`${y}-10-${String(nth(y, 9, 1, 2)).padStart(2, "0")}`]: "Indigenous Peoples Day",
    [`${y}-11-11`]: "Veterans Day",
    [`${y}-11-${String(nth(y, 10, 4, 4)).padStart(2, "0")}`]: "Thanksgiving",
    [`${y}-12-25`]: "Christmas Day",
  };
}
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const cityHoliday = (d) => cityHolidays(d.getFullYear())[isoDate(d)] || null;
// The map shows a weekday; the date it stands for is that weekday's next occurrence, counting today.
export function nextDate(day, from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + ((DAYS.indexOf(day) - d.getDay() + 7) % 7));
  return d;
}

export function fmtRate(rule) {
  const rates = rule.rate || rule.rates || [];
  if (!rates.length) return null;
  const r = rates[0];
  if (r?.rate == null) return null; // a meter whose rate the data doesn't give
  const dollars = (r.rate / 100).toFixed(2);
  const unit = r.rate_unit || "hour";
  const per = r.rate_unit_period ? ` / ${r.rate_unit_period} ${unit}` : ` / ${unit}`;
  return `$${dollars}${per}`;
}

// "08:00" → "8 AM", "13:30" → "1:30 PM", "24:00"/"00:00" → "12 AM".
export function fmtTime(hhmm) {
  const m = minutes(hhmm);
  if (m == null) return "";
  const h = Math.floor(m / 60) % 24, mm = m % 60;
  return `${((h + 11) % 12) + 1}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const cap = (d) => d[0].toUpperCase() + d.slice(1);
// ["mon","tue","wed","thu","fri"] → "Mon–Fri"; all seven → "Every day"; gaps → "Mon, Wed, Fri".
export function fmtDays(days) {
  const idx = [...new Set((days || []).map((d) => WEEK.indexOf(d.toLowerCase().slice(0, 3))).filter((i) => i >= 0))].sort((a, b) => a - b);
  if (!idx.length || idx.length === 7) return "Every day";
  const runs = [];
  for (const i of idx) { const r = runs[runs.length - 1]; r && r[1] === i - 1 ? (r[1] = i) : runs.push([i, i]); }
  return runs.map(([a, b]) => (a === b ? cap(WEEK[a]) : b === a + 1 ? `${cap(WEEK[a])}, ${cap(WEEK[b])}` : `${cap(WEEK[a])}–${cap(WEEK[b])}`)).join(", ");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ORD = ["", "1st", "2nd", "3rd", "4th", "5th"];
// [4,5,...,11] → "Apr–Nov"; non-contiguous → "May, Jun, Aug".
function fmtMonths(ms) {
  const m = [...new Set(ms)].sort((a, b) => a - b);
  const contiguous = m.every((x, i) => !i || x === m[i - 1] + 1);
  return contiguous && m.length > 2 ? `${MONTHS[m[0] - 1]}–${MONTHS[m[m.length - 1] - 1]}` : m.map((x) => MONTHS[x - 1]).join(", ");
}

export function fmtSpan(s) {
  if (!s) return "Every day, all day";
  let days = fmtDays(s.days_of_week);
  if (s.weeks_of_month?.length && s.weeks_of_month.length < 5) days = `${s.weeks_of_month.map((w) => ORD[w]).join(" & ")} ${days} of the month`;
  const a = s.time_of_day_start, b = s.time_of_day_end;
  let out = !a && !b || (a && b && minutes(a) === minutes(b)) ? `${days}, all day` : `${days}, ${fmtTime(a || "00:00")}–${fmtTime(b || "24:00")}`;
  if (s.months?.length && s.months.length < 12) out += ` (${fmtMonths(s.months)})`;
  const dp = designatedPeriods(s.designated_period);
  if (dp.length) out = `${EVENT_PERIODS.test(dp.join()) ? "Only during" : "On"} ${dp.join(", ")}: ${out}`;
  return out;
}

// A compact schedule for a popup tag: "1st, 3rd & 5th Wed · 12–4 PM · Mar–Dec", "Sun · 6 AM–8 PM",
// "during snow emergencies". Several spans join with "; ".
const andList = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} & ${xs[xs.length - 1]}`);
function fmtRange(a, b) {
  const x = fmtTime(a || "00:00"), y = fmtTime(b || "24:00");
  const [xt, xm] = x.split(" "), [yt, ym] = y.split(" ");
  return xm === ym ? `${xt}–${yt} ${ym}` : `${x}–${y}`;
}
export function fmtSpanShort(s) {
  if (!s) return "every day";
  const dp = designatedPeriods(s.designated_period);
  if (dp.length && EVENT_PERIODS.test(dp.join())) return `during ${dp.map((d) => (/emergenc|event|game/.test(d) ? `${d.replace(/y$/, "ie")}s` : d)).join(", ")}`;
  let days = fmtDays(s.days_of_week);
  if (s.weeks_of_month?.length && s.weeks_of_month.length < 5) days = `${andList(s.weeks_of_month.map((w) => ORD[w]))} ${days}`;
  const a = s.time_of_day_start, b = s.time_of_day_end;
  const parts = [days, !a && !b || (a && b && minutes(a) === minutes(b)) ? "all day" : fmtRange(a, b)];
  if (s.months?.length && s.months.length < 12) parts.push(fmtMonths(s.months));
  return parts.join(" · ");
}

// ---------- collapsing repeated rules (popup) ----------
// The feed often lists the same rule several times — e.g. "street cleaning, every day 12:01–7 AM" next to
// "street cleaning, Wed 12:01–7 AM" — which says nothing extra. A policy is redundant when another one with the same
// rule (activity, limits, rates, who it's for) is in force at every time it is.
const sameSet = (a, b) => !a?.length || (b?.length && b.every((x) => a.includes(x))); // a ⊇ b (empty = all)
const lower3 = (ds) => ds?.map((d) => String(d).toLowerCase().slice(0, 3));
export function spanCovers(a, b) {
  if (!a) return true;
  if (!b) return false;
  // A span limited to a designated period (snow emergency, school days) only covers that same period; one without a
  // period covers any (the period only narrows when b applies).
  const pa = designatedPeriods(a.designated_period).join();
  if (pa && pa !== designatedPeriods(b.designated_period).join()) return false;
  if (!sameSet(lower3(a.days_of_week), lower3(b.days_of_week)) || !sameSet(a.months, b.months)) return false;
  const aw = a.weeks_of_month?.length < 5 ? a.weeks_of_month : null, bw = b.weeks_of_month?.length < 5 ? b.weeks_of_month : null;
  if (!sameSet(aw, bw)) return false;
  if ((a.start_date && a.start_date !== b.start_date) || (a.end_date && a.end_date !== b.end_date)) return false;
  const as = startMinutes(a.time_of_day_start) ?? 0, ae = minutes(a.time_of_day_end) ?? 1440, bs = startMinutes(b.time_of_day_start) ?? 0, be = minutes(b.time_of_day_end) ?? 1440;
  if (as === ae || (as === 0 && ae === 1440)) return true; // a runs all day
  if (as === bs && ae === be) return true;
  return as < ae && bs < be && as <= bs && be <= ae; // same-day windows: a's contains b's
}
export const policyCovers = (a, b) => !(a.time_spans || []).length || (b.time_spans || []).length > 0 && b.time_spans.every((sb) => a.time_spans.some((sa) => spanCovers(sa, sb)));
const ruleKey = (p) => { const r = ruleOf(p); return JSON.stringify([isStreetCleaning(p), isMetered(p), r.activity, r.max_stay, r.user_classes, r.user_classes_except, r.rate || r.rates]); };
// A rule that can never take effect: a higher-precedence one (CDS: lower priority number) is in force at every time
// it is — e.g. a hydrant's "no stopping, all day" over a "2 hr parking Mon–Fri" and a sweeping schedule on the same
// curb. Meters don't count as overriding: they go free on Sundays, holidays and after hours, letting the rest through.
// Returns the overriding policy, or null.
export function overriddenBy(p, others) {
  const pr = p.priority ?? 1000;
  const meterUnderSign = (a) => isMetered(p) && kindOf(a).category === "free"; // the meter still applies (see verdict)
  // Accessible spaces are real spaces on the stretch whatever their priority: never folded away, never fold others.
  if (kindOf(p).category === "accessible") return null;
  return others.find((a) => a !== p && isRealPolicy(a) && (a.priority ?? 1000) < pr && !isMetered(a) && !meterUnderSign(a) && kindOf(a).category !== "accessible" && policyCovers(a, p)) || null;
}

// pols in display order → [{ policy, absorbed: [policies it makes redundant] }]. Earlier entries win ties.
export function collapsePolicies(pols) {
  const out = [];
  for (const p of pols) {
    const k = ruleKey(p);
    const host = out.find((o) => o.key === k && policyCovers(o.policy, p));
    if (host) { host.absorbed.push(p); continue; }
    // A later, broader copy replaces earlier narrower ones (Wed listed before "every day").
    const entry = { policy: p, key: k, absorbed: [] };
    for (let i = out.length - 1; i >= 0; i--) if (out[i].key === k && policyCovers(p, out[i].policy)) { entry.absorbed.push(out[i].policy, ...out[i].absorbed); out.splice(i, 1); }
    out.push(entry);
  }
  return out.map(({ policy, absorbed }) => ({ policy, absorbed }));
}

export function dayKey(d = new Date()) { return DAYS[d.getDay()]; }

// ---------- "Can I stay here from A to B?" ----------
// A stay is walked in 30-minute steps (Boston's rule times fall on :00 and :30). Each step resolves the winning rule,
// then the stay as a whole is graded for the driver:
//   ok      allowed the whole time (and inside any time limit)
//   better  allowed throughout and improves partway (paid until 6 PM, then free)
//   breaks  allowed at the start, then restricted or the time limit runs out
//   no      not allowed at the start
// "worst" is the most restrictive category met during the stay — what the map colors the curb by.
export const STEP_MIN = 30;
export function allowedFor(cat, profile = {}) {
  return cat === "free" || cat === "paid" || (cat === "resident" && !!profile.permit) || (cat === "accessible" && !!profile.placard)
    || (cat === "accessible_permit" && !!profile.placard && !!profile.permit);
}
// Lower is better for a driver; anything not allowed ranks above every allowed category.
const RANK = { free: 0, resident: 1, accessible: 1, accessible_permit: 1, paid: 2, loading: 3, unknown: 4, no_parking: 5, street_cleaning: 5, travel: 6, no_stopping: 7 };
export const rankFor = (cat, profile) => (allowedFor(cat, profile) ? 0 : 10) + (RANK[cat] ?? 4);

// The 30-minute steps of a stay starting at `start` (Date) for `minutes`. Each step is resolved at its midpoint,
// on that moment's own weekday (stays can cross midnight) with meters free on Sundays and City holidays.
export function stayWindow(start, minutes) {
  const n = Math.max(1, Math.ceil(minutes / STEP_MIN)), end = start.getTime() + minutes * 60000, out = [];
  for (let i = 0; i < n; i++) {
    const a = start.getTime() + i * STEP_MIN * 60000, b = Math.min(end, a + STEP_MIN * 60000), mid = new Date((a + b) / 2);
    const day = dayKey(mid);
    out.push({ start: new Date(a), end: new Date(b), day, minute: mid.getHours() * 60 + mid.getMinutes(), meterFree: day === "sun" || !!cityHoliday(mid), date: mid });
  }
  return out;
}

export function evaluateStay(zone, policies, steps, profile = {}) {
  // Each step keeps a policy → active memo, so grading many zones over the same steps checks each policy once per step.
  const vs = steps.map((st) => verdict(zone, policies, st.day, st.minute, { meterFree: st.meterFree, date: st.date, active: (st.active ||= new Map()) }));
  const cats = vs.map((v) => v.category);
  const timeline = [];
  cats.forEach((c, i) => {
    const last = timeline[timeline.length - 1];
    if (last && last.cat === c) last.to = steps[i].end; else timeline.push({ cat: c, from: steps[i].start, to: steps[i].end });
  });
  let worst = cats[0], best = cats[0];
  for (const c of cats) { if (rankFor(c, profile) > rankFor(worst, profile)) worst = c; if (rankFor(c, profile) < rankFor(best, profile)) best = c; }
  const res = (fit, at = null, reason = null) => ({ fit, at, reason, worst, best, timeline });
  if (!allowedFor(cats[0], profile)) return res("no", steps[0].start, { kind: "rule", cat: cats[0] });
  // Time limits run from when the limited rule starts applying (arrival, or later if it kicks in mid-stay) and stop
  // mattering once it ends — a 2-hour meter that ends at 6 PM doesn't cut short a 5–8 PM stay.
  let lim = null;
  for (let i = 0; i < steps.length; i++) {
    if (!allowedFor(cats[i], profile)) return res("breaks", steps[i].start, { kind: "rule", cat: cats[i] });
    const max = vs[i].meterFree ? null : vs[i].rule?.max_stay;
    if (!max) { lim = null; continue; }
    if (!lim || lim.policy !== vs[i].policy) lim = { policy: vs[i].policy, since: steps[i].start.getTime(), max };
    if ((steps[i].end.getTime() - lim.since) / 60000 > lim.max) {
      worst = cats[i];
      return res("breaks", new Date(lim.since + lim.max * 60000), { kind: "limit", max, cat: cats[i] });
    }
  }
  const r0 = rankFor(cats[0], profile), bi = cats.findIndex((c) => rankFor(c, profile) < r0);
  return bi > 0 ? res("better", steps[bi].start, { kind: "better", cat: cats[bi] }) : res("ok");
}
