// Moderation. Every call needs the X-Admin-Token header (ADMIN_TOKEN).
//   GET  /api/review?status=pending          the queue (with photo links and confirmation counts)
//   GET  /api/review?curb=<id>                one curb's submissions and full event history
//   POST /api/review { id, decision: accept | reject | revert, note, reviewer }
// Accepting a correction supersedes earlier accepted ones for the same curb that overlap its stretch. Accepted
// corrections reach the map on the next build; set DEPLOY_HOOK_URL (a Vercel deploy hook) to start one right away.
import { db, photoUrl, bodyOf, isAdmin, reply, replyError, UUID, event } from "./_db.js";

const SELECT = "id,created_at,kind,curb_zone_id,stretch_from,stretch_to,curb_length,curb_lng,curb_lat,rules,based_on,data_version,note,photo_path,lat,lng,accuracy_m,device_id,status,reviewed_at,reviewer,review_note,confirmations(count)";
const withPhotos = (rows) => Promise.all((rows || []).map(async (r) => ({ ...r, confirmations: r.confirmations?.[0]?.count || 0, photo_url: r.photo_path ? await photoUrl(r.photo_path) : null })));
const overlaps = (a, b) => a.stretch_from == null || b.stretch_from == null || (a.stretch_from < b.stretch_to && b.stretch_from < a.stretch_to);

export default async function handler(req, res) {
  if (!isAdmin(req)) return reply(res, 401, { error: "admin token required" });
  try {
    if (req.method === "GET") {
      const curb = String(req.query?.curb || "");
      if (curb) {
        if (!UUID.test(curb)) throw new Error("unknown curb");
        const [subs, events] = await Promise.all([
          db(`submissions?select=${SELECT}&curb_zone_id=eq.${curb}&order=created_at.desc&limit=200`),
          db(`events?select=*&curb_zone_id=eq.${curb}&order=at.desc&limit=500`),
        ]);
        return reply(res, 200, { submissions: await withPhotos(subs.data), events: events.data || [] });
      }
      const status = ["pending", "accepted", "rejected", "superseded"].includes(req.query?.status) ? req.query.status : "pending";
      const { data } = await db(`submissions?select=${SELECT}&kind=eq.correction&status=eq.${status}&order=created_at.${status === "pending" ? "asc" : "desc"}&limit=100`);
      return reply(res, 200, { submissions: await withPhotos(data) });
    }
    if (req.method !== "POST") return reply(res, 405, { error: "GET or POST" });
    const b = bodyOf(req), reviewer = String(b.reviewer || "moderator").slice(0, 60), note = String(b.note || "").slice(0, 1000) || null;
    if (!UUID.test(b.id || "")) throw new Error("bad id");
    const { data } = await db(`submissions?select=${SELECT}&id=eq.${b.id}`);
    const sub = data?.[0];
    if (!sub || sub.kind !== "correction") throw new Error("no such correction");
    const now = new Date().toISOString();
    const set = (status) => db(`submissions?id=eq.${sub.id}`, { method: "PATCH", body: { status, reviewed_at: now, reviewer, review_note: note } });
    if (b.decision === "accept") {
      if (sub.status !== "pending") throw new Error(`it's ${sub.status}, not pending`);
      await set("accepted");
      await event(`reviewer:${reviewer}`, "accepted", { submission_id: sub.id, curb_zone_id: sub.curb_zone_id, detail: { note } });
      const { data: prior } = await db(`submissions?select=id,stretch_from,stretch_to&kind=eq.correction&status=eq.accepted&curb_zone_id=eq.${sub.curb_zone_id}&id=neq.${sub.id}`);
      for (const p of (prior || []).filter((p) => overlaps(p, sub))) {
        await db(`submissions?id=eq.${p.id}`, { method: "PATCH", body: { status: "superseded" } });
        await event(`reviewer:${reviewer}`, "superseded", { submission_id: p.id, curb_zone_id: sub.curb_zone_id, detail: { by: sub.id } });
      }
    } else if (b.decision === "reject") {
      if (sub.status !== "pending") throw new Error(`it's ${sub.status}, not pending`);
      await set("rejected");
      await event(`reviewer:${reviewer}`, "rejected", { submission_id: sub.id, curb_zone_id: sub.curb_zone_id, detail: { note } });
    } else if (b.decision === "revert") {
      if (sub.status !== "accepted") throw new Error("only an accepted correction can be reverted");
      await set("rejected");
      await event(`reviewer:${reviewer}`, "reverted", { submission_id: sub.id, curb_zone_id: sub.curb_zone_id, detail: { note } });
    } else throw new Error("decision must be accept, reject or revert");
    let rebuild = false;
    if (b.decision !== "reject" && process.env.DEPLOY_HOOK_URL) { rebuild = (await fetch(process.env.DEPLOY_HOOK_URL, { method: "POST" }).catch(() => null))?.ok || false; }
    return reply(res, 200, { ok: true, rebuild });
  } catch (e) { return replyError(res, e); }
}
