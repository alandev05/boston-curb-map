// POST /api/submit — a correction (proposed rules for a curb or a stretch of it) or a "looks right" confirmation.
// Body: { kind, curb_zone_id, stretch: [from, to] | null, curb_length, rules, based_on, data_version, note,
//         point: [lng, lat] (where the curb was tapped), location: { lat, lng, accuracy } | null (the submitter),
//         device_id, photo: "data:image/jpeg;base64,…" | null }
import { randomUUID } from "node:crypto";
import { validateRules } from "../src/submission.js";
import { db, putPhoto, bodyOf, ipHash, reply, replyError, UUID, event } from "./_db.js";

export const DAILY_LIMIT = 40;
const MAX_PHOTO = 4 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== "POST") return reply(res, 405, { error: "POST only" });
  try {
    const b = bodyOf(req);
    if (!["correction", "confirm"].includes(b.kind)) throw new Error("kind must be correction or confirm");
    if (!UUID.test(b.curb_zone_id || "")) throw new Error("unknown curb");
    if (!UUID.test(b.device_id || "")) throw new Error("missing device id");
    const stretch = b.stretch == null ? null : b.stretch.map(Number);
    if (stretch && !(stretch.length === 2 && stretch.every(Number.isFinite) && stretch[0] >= 0 && stretch[1] > stretch[0])) throw new Error("bad stretch");
    const rules = b.kind === "correction" ? validateRules(b.rules) : null;
    const loc = b.location && Number.isFinite(+b.location.lat) && Number.isFinite(+b.location.lng) ? b.location : null;
    const pt = Array.isArray(b.point) && b.point.length === 2 && b.point.every((n) => Number.isFinite(+n)) && Math.abs(b.point[0] + 71.07) < 0.5 && Math.abs(b.point[1] - 42.33) < 0.5 ? b.point.map(Number) : null;

    // Rate limit per device and per network.
    const ip = ipHash(req), since = new Date(Date.now() - 86400000).toISOString();
    const recent = await db(`submissions?select=id&created_at=gte.${since}&or=(device_id.eq.${b.device_id}${ip ? `,ip_hash.eq.${ip}` : ""})&limit=1`, { prefer: "count=exact" });
    if (recent.count >= DAILY_LIMIT) return reply(res, 429, { error: "Too many submissions today — try again tomorrow." });

    const id = randomUUID();
    let photo_path = null;
    if (b.photo) {
      const m = String(b.photo).match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      const buf = m && Buffer.from(m[1], "base64");
      if (!buf || buf.length > MAX_PHOTO || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("photo must be a JPEG under 4 MB");
      photo_path = `${b.curb_zone_id}/${id}.jpg`;
      await putPhoto(photo_path, buf);
    }
    const row = {
      id, kind: b.kind, curb_zone_id: b.curb_zone_id,
      stretch_from: stretch?.[0] ?? null, stretch_to: stretch?.[1] ?? null,
      curb_length: Number.isFinite(+b.curb_length) ? +b.curb_length : null, curb_lng: pt?.[0] ?? null, curb_lat: pt?.[1] ?? null,
      rules, based_on: String(b.based_on || "").slice(0, 4000) || null, data_version: String(b.data_version || "").slice(0, 40) || null,
      note: String(b.note || "").slice(0, 1000) || null, photo_path,
      lat: loc ? +loc.lat : null, lng: loc ? +loc.lng : null, accuracy_m: loc && Number.isFinite(+loc.accuracy) ? +loc.accuracy : null,
      device_id: b.device_id, ip_hash: ip,
    };
    await db("submissions", { method: "POST", body: row });
    await event(`device:${b.device_id}`, b.kind === "correction" ? "submitted" : "confirmed_current", { submission_id: id, curb_zone_id: b.curb_zone_id, detail: { stretch, photo: !!photo_path } });
    // A newer correction from the same device for the same curb replaces their earlier pending one.
    if (b.kind === "correction") {
      const { data: older } = await db(`submissions?select=id&kind=eq.correction&status=eq.pending&curb_zone_id=eq.${b.curb_zone_id}&device_id=eq.${b.device_id}&id=neq.${id}`);
      for (const o of older || []) {
        await db(`submissions?id=eq.${o.id}`, { method: "PATCH", body: { status: "superseded" } });
        await event(`device:${b.device_id}`, "superseded", { submission_id: o.id, curb_zone_id: b.curb_zone_id, detail: { by: id } });
      }
    }
    return reply(res, 201, { id, status: "pending" });
  } catch (e) { return replyError(res, e); }
}
