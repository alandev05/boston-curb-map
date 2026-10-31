// Shared helper for proxying Boston's CDS Curbs API (https://cds-curb-api.boston.gov)
// We proxy server-side so the browser never fights CORS and Vercel's edge cache absorbs load.

export const CDS_BASE = process.env.CDS_BASE || "https://cds-curb-api.boston.gov";
const ACCEPTS = ["application/vnd.cds+json;version=1.0", "application/json"];
const UA = "boston-curb-map/0.1 (+https://github.com/alandev05/boston-curb-map)";

export async function cdsGet(path, params = {}) {
  const url = new URL(path, CDS_BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  let lastErr;
  for (const accept of ACCEPTS) {
    try {
      const r = await fetch(url, { headers: { Accept: accept, "User-Agent": UA } });
      if (r.ok) return await r.json();
      if (r.status === 406 || r.status === 415) continue; // wrong Accept, try next
      lastErr = new Error(`CDS ${r.status} for ${url.pathname}`);
      if (r.status === 404) break;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("CDS unreachable");
}

// CDS wraps results: { version, time_zone, last_updated, data: { zones: [...] } }
export function unwrap(payload, key) {
  const d = payload?.data ?? payload;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d[key])) return d[key];
  if (d && Array.isArray(d.features)) return d.features;
  return [];
}

export function send(res, body, maxAge = 3600) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", `public, s-maxage=${maxAge}, stale-while-revalidate=86400`);
  res.status(200).send(JSON.stringify(body));
}

export function fail(res, err, status = 502) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(status).send(JSON.stringify({ error: String(err?.message || err) }));
}
