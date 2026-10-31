// Turn CDS policies into a single "what applies at this moment" verdict per zone.
// CDS Curbs spec: https://github.com/openmobilityfoundation/curb-data-specification/tree/main/curbs

export const CATEGORIES = {
  no_stopping: { label: "No stopping", color: "#ff4d6d", blurb: "Don't even pause here." },
  no_parking:  { label: "No parking",  color: "#ff8c42", blurb: "Drop-off/pick-up only." },
  travel:      { label: "Travel lane", color: "#6c757d", blurb: "Rush-hour lane — cars get towed." },
  loading:     { label: "Loading zone", color: "#ffd166", blurb: "Commercial loading only." },
  paid:        { label: "Paid meter", color: "#4d9fff", blurb: "Feed the meter or ParkBoston app." },
  resident:    { label: "Resident permit", color: "#b388ff", blurb: "Neighborhood sticker required." },
  accessible:  { label: "Accessible", color: "#ff7ad9", blurb: "Disability placard only." },
  free:        { label: "Free / time-limit", color: "#2ec4b6", blurb: "Free, maybe with a time cap." },
  unknown:     { label: "Unknown", color: "#c9c9c9", blurb: "No policy data for this time." },
};

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function minutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + (m || 0);
}

// Does a CDS time_span cover (day, minute-of-day)?
export function spanActive(span, day, minute) {
  if (!span) return true;
  if (span.days_of_week?.length && !span.days_of_week.map((d) => d.toLowerCase().slice(0, 3)).includes(day)) return false;
  const s = minutes(span.time_of_day_start), e = minutes(span.time_of_day_end);
  if (s != null && e != null) {
    if (s <= e) { if (minute < s || minute >= e) return false; }
    else if (minute < s && minute >= e) return false; // overnight span
  } else if (s != null && minute < s) return false;
  else if (e != null && minute >= e) return false;
  // Date-bounded spans (e.g. seasonal street sweeping) — assume active if no dates or within.
  const today = new Date();
  if (span.start_date && new Date(span.start_date) > today) return false;
  if (span.end_date && new Date(span.end_date) < today) return false;
  return true;
}

export function policyActive(policy, day, minute) {
  const spans = policy.time_spans || [];
  if (!spans.length) return true;
  return spans.some((s) => spanActive(s, day, minute));
}

const CLASS_HINTS = {
  resident: /resident|permit/i,
  accessible: /disab|handicap|accessib|ada/i,
  loading: /commercial|truck|freight|delivery/i,
};

export function categorize(rule) {
  const activity = String(rule.activity || "").toLowerCase().replace(/_/g, " ");
  const classes = (rule.user_classes || []).join(" ");
  const purposes = (rule.purposes || []).join(" ").toLowerCase();
  if (activity === "travel") return "travel";
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
export function verdict(zone, policies, day, minute) {
  const ids = zone.curb_policy_ids || [];
  let best = null;
  for (const id of ids) {
    const p = policies[id];
    if (!p || !policyActive(p, day, minute)) continue;
    const pr = p.priority ?? 1000;
    if (!best || pr < best.pr) best = { pr, p };
  }
  if (!best) return { category: ids.length ? "unknown" : "unknown", rule: null, policy: null };
  const rule = (best.p.rules || [])[0] || {};
  return { category: categorize(rule), rule, policy: best.p };
}

export function fmtRate(rule) {
  const rates = rule.rate || rule.rates || [];
  if (!rates.length) return null;
  const r = rates[0];
  const dollars = (r.rate / 100).toFixed(2);
  const unit = r.rate_unit || "hour";
  const per = r.rate_unit_period ? ` / ${r.rate_unit_period} ${unit}` : ` / ${unit}`;
  return `$${dollars}${per}`;
}

export function fmtSpan(s) {
  if (!s) return "always";
  const days = s.days_of_week?.length ? s.days_of_week.map((d) => d.slice(0, 3)).join(" ") : "daily";
  const t = s.time_of_day_start || s.time_of_day_end ? ` ${s.time_of_day_start || "00:00"}–${s.time_of_day_end || "24:00"}` : "";
  return days + t;
}

export function dayKey(d = new Date()) { return DAYS[d.getDay()]; }
