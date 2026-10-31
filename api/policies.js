import { cdsGet, unwrap, send, fail } from "./_cds.js";

// GET /api/policies            -> every policy (cached 6h)
// GET /api/policies?ids=a,b,c  -> just those
export default async function handler(req, res) {
  try {
    const ids = (req.query.ids || "").trim();
    const policies = {};
    if (ids) {
      const list = ids.split(",").filter(Boolean);
      for (let i = 0; i < list.length; i += 50) {
        const js = await cdsGet("/curbs/policies", { ids: list.slice(i, i + 50).join(",") });
        for (const p of unwrap(js, "policies")) policies[p.curb_policy_id] = p;
      }
    } else {
      const js = await cdsGet("/curbs/policies", {});
      for (const p of unwrap(js, "policies")) policies[p.curb_policy_id] = p;
    }
    send(res, policies, ids ? 3600 : 21600);
  } catch (e) { fail(res, e); }
}
