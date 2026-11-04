#!/usr/bin/env node
// Build-time data step: fetch the city feed, then tile it. Never fails the build —
// if the city API is unreachable and nothing is cached, the site runs in API mode.
//   npm run data            # fetch + tile
//   npm run data -- --offline   # tile from data/raw without fetching
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = path.join(root, "data", "raw", "zones.geojson");
const offline = process.argv.includes("--offline") || process.env.DATA_OFFLINE === "1";
const run = (script) => spawnSync(process.execPath, [path.join(root, "scripts", script), ...(offline ? ["--offline"] : [])], { stdio: "inherit", env: process.env }).status === 0;

if (!offline && !run("fetch-meters.js")) console.error("fetch-meters failed; tiles will carry whatever data/raw/meters.geojson exists");
if (!offline && !run("fetch-addresses.js")) console.error("fetch-addresses failed; street-sweeping sides will use whatever data/raw/addresses.json exists");
if (!offline && !run("fetch-sweeping.js")) console.error("fetch-sweeping failed; tiles will use whatever data/raw/sweeping.csv exists");
if (!offline && !run("fetch-submissions.js")) console.error("fetch-submissions failed; tiles will use whatever data/raw/submissions.json exists");
if (!offline && !run("fetch-cds.js")) console.error("fetch-cds failed; " + (existsSync(raw) ? "tiling the cached data/raw instead" : "no cached data — site will use the runtime API"));
if (existsSync(raw)) {
  if (!run("build-tiles.js")) { console.error("build-tiles failed; removing stale tiles"); await rm(path.join(root, "public", "tiles"), { recursive: true, force: true }); await rm(path.join(root, "public", "data"), { recursive: true, force: true }); }
} else {
  await rm(path.join(root, "public", "tiles"), { recursive: true, force: true });
  await rm(path.join(root, "public", "data"), { recursive: true, force: true });
}
