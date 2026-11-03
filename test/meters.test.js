import { describe, it, expect, afterEach } from "vitest";
import { mockFetch } from "./helpers.js";
import { fetchMeters, fetchMetersHub, slimProps, HUB_ITEM } from "../scripts/fetch-meters.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const pt = (i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [-71.06 + i * 1e-4, 42.35] }, properties: { OBJECTID: i, METER_ID: `M${i}`, STREET: "Boylston St", PAY_POLICY: "2HR", SHAPE_Length: 0, GlobalID: "x", EditDate: "2026" } });
const hubItem = (url) => ({ data: { id: HUB_ITEM, attributes: { url, recordCount: 4500, fields: [{ name: "METER_ID" }] } } });

describe("slimProps", () => {
  it("keeps meter/street/policy fields and drops ArcGIS housekeeping + empties", () => {
    expect(slimProps(pt(1).properties)).toEqual({ OBJECTID: 1, METER_ID: "M1", STREET: "Boylston St", PAY_POLICY: "2HR" });
    expect(slimProps({ METER_ID: "", STREET: null, ZONE: "2001" })).toEqual({ ZONE: "2001" });
  });
  it("keeps the schedule fields the build turns into curb rules", () => {
    const p = { PARK_NO_PAY: "00:00AM-24:00AM SUN", TOW_AWAY: "04:00PM-06:00PM MON-FRI", DIR: "N", METER_STATE: "ACTIVE", NUMBEROFSPACES: 1, INSTALLED_ON: "1/1/2017" };
    expect(slimProps(p)).toEqual({ PARK_NO_PAY: p.PARK_NO_PAY, TOW_AWAY: p.TOW_AWAY, DIR: "N", METER_STATE: "ACTIVE", NUMBEROFSPACES: 1 });
  });
});

describe("fetchMetersHub", () => {
  it("resolves the Hub item to its FeatureServer layer and pages /query as GeoJSON", async () => {
    const layer = "https://services7.arcgis.com/x/arcgis/rest/services/Parking_Meters/FeatureServer/0";
    const f = mockFetch([
      { match: (u) => u.pathname.endsWith(`/api/v3/datasets/${HUB_ITEM}`), respond: { body: hubItem(layer) } },
      { match: (u) => u.pathname.endsWith("/FeatureServer/0/query"), respond: (u) => {
        const off = Number(u.searchParams.get("resultOffset")), n = Number(u.searchParams.get("resultRecordCount"));
        const total = 4500; const feats = Array.from({ length: Math.max(0, Math.min(n, total - off)) }, (_, i) => pt(off + i));
        return { body: { type: "FeatureCollection", features: feats, properties: { exceededTransferLimit: off + n < total } } };
      } },
    ]);
    const { features, source } = await fetchMetersHub({ log: () => {} });
    expect(source).toBe(layer);
    expect(features).toHaveLength(4500);
    expect(new Set(features.map((x) => x.properties.METER_ID)).size).toBe(4500);
    const q = f.calls.filter((c) => c.url.pathname.endsWith("/query"));
    expect(q).toHaveLength(3); // 2000 + 2000 + 500
    expect(q[0].url.searchParams.get("f")).toBe("geojson");
    expect(q[0].url.searchParams.get("outSR")).toBe("4326");
    expect(q[2].url.searchParams.get("resultOffset")).toBe("4000");
    expect(features[0].properties.GlobalID).toBeUndefined();
  });
  it("skips non-point geometries and surfaces ArcGIS error payloads", async () => {
    mockFetch([
      { match: (u) => u.pathname.includes("/api/v3/datasets/"), respond: { body: hubItem("https://x/FeatureServer/0") } },
      { match: (u) => u.pathname.endsWith("/query"), respond: { body: { type: "FeatureCollection", features: [pt(1), { type: "Feature", geometry: { type: "Polygon", coordinates: [] }, properties: {} }] } } },
    ]);
    expect((await fetchMetersHub({ log: () => {} })).features).toHaveLength(1);
    mockFetch([
      { match: (u) => u.pathname.includes("/api/v3/datasets/"), respond: { body: hubItem("https://x/FeatureServer/0") } },
      { match: (u) => u.pathname.endsWith("/query"), respond: { body: { error: { code: 400, message: "Invalid query" } } } },
    ]);
    await expect(fetchMetersHub({ log: () => {} })).rejects.toThrow(/Invalid query/);
  });
});

describe("fetchMeters fallback", () => {
  it("falls back to CKAN when Hub is down", async () => {
    mockFetch([
      { match: (u) => u.hostname.includes("opendata.arcgis.com"), respond: { status: 503, body: {} } },
      { match: (u) => u.pathname.endsWith("package_search"), respond: { body: { success: true, result: { results: [{ title: "Parking Meters", resources: [{ id: "ds1", datastore_active: true }] }] } } } },
      { match: (u) => u.pathname.endsWith("datastore_search"), respond: { body: { success: true, result: { records: [{ METER_ID: "A", LONGITUDE: "-71.06", LATITUDE: "42.35" }, { METER_ID: "bad", LONGITUDE: "42.35", LATITUDE: "-71.06" }] } } } },
    ]);
    const { features, source } = await fetchMeters({ log: () => {} });
    expect(source).toBe("ckan:ds1");
    expect(features).toHaveLength(1);
    expect(features[0].geometry.coordinates).toEqual([-71.06, 42.35]);
  });
});
