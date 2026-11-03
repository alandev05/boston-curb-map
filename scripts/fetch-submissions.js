#!/usr/bin/env node
// Pull accepted community corrections from Supabase into data/raw/submissions.json for the build.
// Needs SUPABASE_URL and SUPABASE_SECRET_KEY (Vercel env, or .env.local); without them it leaves an empty list.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "data", "raw", "submissions.json");

try {
  for (const line of (await readFile(path.join(root, ".env.local"), "utf8")).split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const { SUPABASE_URL: url, SUPABASE_SECRET_KEY: key } = process.env;
await mkdir(path.dirname(OUT), { recursive: true });
if (!url || !key) {
  console.error("fetch-submissions: SUPABASE_URL / SUPABASE_SECRET_KEY not set — no community corrections in this build");
  await writeFile(OUT, "[]");
} else {
  const r = await fetch(`${url}/rest/v1/submissions?select=id,curb_zone_id,stretch_from,stretch_to,curb_length,rules,reviewed_at&kind=eq.correction&status=eq.accepted&order=reviewed_at.asc&limit=10000`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!r.ok) { console.error(`fetch-submissions: ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  const rows = await r.json();
  await writeFile(OUT, JSON.stringify(rows));
  console.log(`fetched ${rows.length} accepted community corrections`);
}
