#!/usr/bin/env node
// Map data for the browser tests (tests-ui/): tiles and data files built from the mock city feed (scripts/mock-cds.js)
// into .ui/public, so the tests never touch the real data in public/ or the network for curbs.
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTiles } from "./build-tiles.js";
import { POLICIES, ZONES, METERS } from "./mock-cds.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".ui", "public");
await rm(out, { recursive: true, force: true });
const features = ZONES.map(({ geometry, ...properties }) => ({ type: "Feature", geometry, properties }));
const meters = METERS.map((m) => ({ type: "Feature", geometry: { type: "Point", coordinates: [+m.LONGITUDE, +m.LATITUDE] }, properties: { METER_ID: m.METER_ID, STREET: m.STREET } }));
const m = await buildTiles(features, POLICIES, { out, log: () => {}, meta: { source: "mock" }, meters });
console.log(`ui fixture: ${m.zones} curbs, ${m.tiles} tiles → ${out}`);
