// POST /api/confirm { submission_id, device_id } — "Matches what I see" on someone else's pending correction.
import { db, bodyOf, ipHash, reply, replyError, UUID, event } from "./_db.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return reply(res, 405, { error: "POST only" });
  try {
    const b = bodyOf(req);
    if (!UUID.test(b.submission_id || "") || !UUID.test(b.device_id || "")) throw new Error("bad request");
    const { data } = await db(`submissions?select=id,status,device_id,curb_zone_id&id=eq.${b.submission_id}`);
    const sub = data?.[0];
    if (!sub || sub.status !== "pending") throw new Error("that correction isn't pending");
    if (sub.device_id === b.device_id) throw new Error("you submitted this one");
    await db("confirmations?on_conflict=submission_id,device_id", { method: "POST", body: { submission_id: sub.id, device_id: b.device_id, ip_hash: ipHash(req) }, prefer: "resolution=ignore-duplicates" });
    await event(`device:${b.device_id}`, "confirmed", { submission_id: sub.id, curb_zone_id: sub.curb_zone_id });
    return reply(res, 200, { ok: true });
  } catch (e) { return replyError(res, e); }
}
