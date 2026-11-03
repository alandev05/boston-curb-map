// GET /api/curb?zone=<city curb id>&device=<id> — what people have said about one curb: pending corrections (with how many others
// confirmed each) and how many times the current rules were confirmed.
import { db, reply, replyError, UUID } from "./_db.js";

export default async function handler(req, res) {
  try {
    const zone = String(req.query?.zone || ""), device = String(req.query?.device || "");
    if (!UUID.test(zone)) throw new Error("unknown curb");
    const { data } = await db(`submissions?select=id,created_at,kind,stretch_from,stretch_to,rules,note,status,device_id,confirmations(count)&curb_zone_id=eq.${zone}&status=in.(pending,accepted)&order=created_at.desc&limit=50`);
    const rows = data || [];
    const pending = rows.filter((r) => r.kind === "correction" && r.status === "pending").map((r) => ({
      id: r.id, created_at: r.created_at, stretch: r.stretch_from != null ? [r.stretch_from, r.stretch_to] : null,
      rules: r.rules, note: r.note, confirmations: r.confirmations?.[0]?.count || 0, mine: !!device && r.device_id === device,
    }));
    const confirms = rows.filter((r) => r.kind === "confirm").length;
    return reply(res, 200, { pending, confirms });
  } catch (e) { return replyError(res, e); }
}
