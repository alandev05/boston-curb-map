// GET /api/cron — run once a day by Vercel Cron (vercel.json "crons"). Two jobs:
//   1. touch Supabase, so a free project never goes idle long enough to be paused;
//   2. POST the Vercel deploy hook (DEPLOY_HOOK_URL), so the map is rebuilt with fresh city data and any corrections
//      accepted since the last deploy.
// Vercel sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set; anything else is refused.
import { db, reply } from "./_db.js";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers?.authorization !== `Bearer ${secret}`) return reply(res, 401, { error: "cron only" });
  const out = { supabase: "skipped", rebuild: "skipped" };
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
    try { await db("events?select=id&limit=1"); out.supabase = "ok"; } catch (e) { out.supabase = String(e.message || e); }
  }
  if (process.env.DEPLOY_HOOK_URL) {
    const r = await fetch(process.env.DEPLOY_HOOK_URL, { method: "POST" }).catch((e) => ({ ok: false, status: String(e.message || e) }));
    out.rebuild = r.ok ? "started" : `failed (${r.status})`;
  }
  return reply(res, 200, out);
}
