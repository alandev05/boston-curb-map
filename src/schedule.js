// Weekly schedule encoding shared by the tile builder (Node) and the map (browser).
// A zone's rule for every hour of the week is one 168-character string: index = day*24 + hour,
// days ordered mon..sun, one letter per category. The map colors tiles with
// ["slice", ["get","sched"], i, i+1] — changing the hour never touches the data.
import { verdict } from "./rules.js";

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const CODES = { no_stopping: "s", no_parking: "n", travel: "t", loading: "l", paid: "p", resident: "r", accessible: "a", free: "f", unknown: "u" };
export const CATEGORY_OF = Object.fromEntries(Object.entries(CODES).map(([k, v]) => [v, k]));
export const SLOTS = DAYS.length * 24;

export const slotIndex = (day, hour) => DAYS.indexOf(day) * 24 + hour;

export function encodeSchedule(zoneProps, policies) {
  let out = "";
  for (const day of DAYS) for (let h = 0; h < 24; h++) out += CODES[verdict(zoneProps, policies, day, h * 60).category] || "u";
  return out;
}

// Most common category across the week — used at city-scale zooms where carrying 168 chars per feature is too heavy.
export function dominant(sched) {
  const counts = {};
  for (const ch of sched) counts[ch] = (counts[ch] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "u";
}

// MapLibre expression: the category code of a feature at slot i (tiles carry `sched` at detail zooms, `dom` at overview zooms).
export const codeAt = (i) => ["case", ["has", "sched"], ["slice", ["get", "sched"], i, i + 1], ["coalesce", ["get", "dom"], "u"]];
