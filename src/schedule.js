// Weekly schedule encoding shared by the tile builder (Node) and the map (browser).
// A zone's rule for every half hour of the week is one 336-character string: index = day*48 + floor(minute/30),
// days ordered mon..sun, one letter per category (Boston's rule times fall on :00 and :30; each slot is resolved at
// its midpoint, so "12:01 AM" counts from midnight). The tile builder keeps only its most common letter (`dom`) as a
// fallback color; the map grades the actual date in the browser (see gradeAll in main.js).
import { verdict } from "./rules.js";

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const CODES = { no_stopping: "s", no_parking: "n", street_cleaning: "c", travel: "t", loading: "l", paid: "p", resident: "r", accessible: "a", free: "f", unknown: "u" };
export const CATEGORY_OF = Object.fromEntries(Object.entries(CODES).map(([k, v]) => [v, k]));
export const SLOT_MIN = 30;
export const SLOTS_PER_DAY = (24 * 60) / SLOT_MIN;
export const SLOTS = DAYS.length * SLOTS_PER_DAY;

// minute = minute of the day (0–1439).
export const slotIndex = (day, minute) => DAYS.indexOf(day) * SLOTS_PER_DAY + Math.floor(minute / SLOT_MIN);

export function encodeSchedule(zoneProps, policies) {
  let out = "";
  for (const day of DAYS) for (let k = 0; k < SLOTS_PER_DAY; k++) out += CODES[verdict(zoneProps, policies, day, k * SLOT_MIN + SLOT_MIN / 2).category] || "u";
  return out;
}

// Most common category across the week — used at city-scale zooms where carrying the full schedule per feature is too heavy.
export function dominant(sched) {
  const counts = {};
  for (const ch of sched) counts[ch] = (counts[ch] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "u";
}

// MapLibre expression: the category code of a feature at slot i (tiles carry `sched` at detail zooms, `dom` at overview zooms).
export const codeAt = (i) => ["case", ["has", "sched"], ["slice", ["get", "sched"], i, i + 1], ["coalesce", ["get", "dom"], "u"]];
