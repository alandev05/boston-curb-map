#!/usr/bin/env node
// City of Boston street-sweeping schedules (Analyze Boston, legacy CSV) → data/raw/sweeping.csv.
// A table, no geometry: street, odd/even side, from/to cross streets, days, weeks of the month, hours, season.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(process.env.DATA_DIR || path.join(root, "data", "raw"), "sweeping.csv");
const PACKAGE = "https://data.boston.gov/api/3/action/package_show?id=street-sweeping-schedules";

const pkg = await (await fetch(PACKAGE)).json();
const res = pkg.result.resources.find((r) => /csv/i.test(r.format));
if (!res) throw new Error("no CSV resource in street-sweeping-schedules");
const r = await fetch(res.url);
if (!r.ok) throw new Error(`sweeping CSV ${r.status}`);
const text = await r.text();
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, text);
console.error(`street sweeping: ${text.trim().split("\n").length - 1} rows → ${OUT}`);
