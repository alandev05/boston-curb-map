import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mockReqRes, mockFetch, cdsEnvelope } from "./helpers.js";
import zones from "../api/zones.js";
import policies from "../api/policies.js";
import meters from "../api/meters.js";
import { cdsGet, unwrap } from "../api/_cds.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const zone = (i, extra = {}) => ({
  curb_zone_id: `z${i}`, user_zone_id: `${2000 + i}`, street_name: "Newbury St", street_side: "N",
  curb_policy_ids: [`p${i % 2}`], geometry: { type: "LineString", coordinates: [[-71.08, 42.35], [-71.079, 42.35]] }, ...extra,
});

describe("_cds helpers", () => {
  it("unwrap handles envelope, bare array, and FeatureCollection", () => {
    expect(unwrap(cdsEnvelope("zones", [1, 2]), "zones")).toEqual([1, 2]);
    expect(unwrap([3], "zones")).toEqual([3]);
    expect(unwrap({ data: { features: [4] } }, "zones")).toEqual([4]);
    expect(unwrap({ data: {} }, "zones")).toEqual([]);
    expect(unwrap(null, "zones")).toEqual([]);
  });

  it("cdsGet sends the CDS Accept header first and a User-Agent", async () => {
    const f = mockFetch([{ match: () => true, respond: { body: { ok: 1 } } }]);
    await cdsGet("/curbs/policies", { limit: 1 });
    expect(f.calls[0].init.headers.Accept).toBe("application/vnd.cds+json;version=1.0");
    expect(f.calls[0].init.headers["User-Agent"]).toMatch(/boston-curb-map/);
    expect(f.calls[0].url.searchParams.get("limit")).toBe("1");
  });

  it("cdsGet falls back to application/json on 406", async () => {
    const f = mockFetch([
      { match: (u, i) => i.headers.Accept.includes("cds"), respond: { status: 406, body: {} } },
      { match: () => true, respond: { body: { fine: true } } },
    ]);
    expect(await cdsGet("/curbs/zones")).toEqual({ fine: true });
    expect(f.calls).toHaveLength(2);
  });

  it("cdsGet drops empty/undefined params", async () => {
    const f = mockFetch([{ match: () => true, respond: { body: {} } }]);
    await cdsGet("/curbs/zones", { a: "", b: undefined, c: 0 });
    expect([...f.calls[0].url.searchParams.keys()]).toEqual(["c"]);
  });

  it("cdsGet throws on 500 and stops on 404", async () => {
    mockFetch([{ match: () => true, respond: { status: 500, body: {} } }]);
    await expect(cdsGet("/curbs/zones")).rejects.toThrow(/500/);
    const f = mockFetch([{ match: () => true, respond: { status: 404, body: {} } }]);
    await expect(cdsGet("/curbs/zones")).rejects.toThrow(/404/);
    expect(f.calls).toHaveLength(1);
  });
});

describe("GET /api/zones", () => {
  it("400s without a valid bbox", async () => {
    for (const q of [{}, { bbox: "1,2,3" }, { bbox: "a,b,c,d" }]) {
      const { req, res } = mockReqRes(q);
      await zones(req, res);
      expect(res.statusCode).toBe(400);
      expect(res.json.error).toMatch(/bbox/);
    }
  });

  it("forwards bbox + include_geometry and converts zones to GeoJSON", async () => {
    const f = mockFetch([{ match: (u) => u.pathname === "/curbs/zones", respond: { body: cdsEnvelope("zones", [zone(1), zone(2)]) } }]);
    const { req, res } = mockReqRes({ bbox: "-71.09,42.348,-71.075,42.353" });
    await zones(req, res);
    expect(res.statusCode).toBe(200);
    const q = f.calls[0].url.searchParams;
    expect(q.get("include_geometry")).toBe("true");
    expect([q.get("min_lng"), q.get("min_lat"), q.get("max_lng"), q.get("max_lat")]).toEqual(["-71.09", "42.348", "-71.075", "42.353"]);
    const fc = res.json;
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]).toMatchObject({ type: "Feature", geometry: { type: "LineString" }, properties: { curb_zone_id: "z1", user_zone_id: "2001" } });
    expect(fc.features[0].properties.geometry).toBeUndefined();
    expect(fc.meta).toMatchObject({ version: "1.0", time_zone: "America/New_York" });
    expect(res.headers["cache-control"]).toMatch(/s-maxage=1800/);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("passes through zones already shaped as Features", async () => {
    const feat = { type: "Feature", id: "z9", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { curb_zone_id: "z9" } };
    mockFetch([{ match: () => true, respond: { body: { data: { zones: [feat] } } } }]);
    const { req, res } = mockReqRes({ bbox: "0,0,1,1" });
    await zones(req, res);
    expect(res.json.features[0]).toEqual(feat);
  });

  it("paginates when a page is full (500) and stops when short", async () => {
    const f = mockFetch([{
      match: () => true,
      respond: (u) => {
        const off = Number(u.searchParams.get("offset"));
        const n = off === 0 ? 500 : 7;
        return { body: cdsEnvelope("zones", Array.from({ length: n }, (_, i) => zone(off + i))) };
      },
    }]);
    const { req, res } = mockReqRes({ bbox: "0,0,1,1" });
    await zones(req, res);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].url.searchParams.get("offset")).toBe("500");
    expect(res.json.features).toHaveLength(507);
  });

  it("502s with the upstream error when CDS fails", async () => {
    mockFetch([{ match: () => true, respond: { status: 503, body: {} } }]);
    const { req, res } = mockReqRes({ bbox: "0,0,1,1" });
    await zones(req, res);
    expect(res.statusCode).toBe(502);
    expect(res.json.error).toMatch(/503/);
  });

  it("returns an empty collection (not an error) for an empty area", async () => {
    mockFetch([{ match: () => true, respond: { body: cdsEnvelope("zones", []) } }]);
    const { req, res } = mockReqRes({ bbox: "0,0,1,1" });
    await zones(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.json.features).toEqual([]);
  });
});

describe("GET /api/policies", () => {
  const pol = (id) => ({ curb_policy_id: id, priority: 5, rules: [{ activity: "parking" }], time_spans: [] });

  it("returns every policy keyed by id with a long cache", async () => {
    const f = mockFetch([{ match: (u) => u.pathname === "/curbs/policies", respond: { body: cdsEnvelope("policies", [pol("a"), pol("b")]) } }]);
    const { req, res } = mockReqRes({});
    await policies(req, res);
    expect(Object.keys(res.json)).toEqual(["a", "b"]);
    expect(f.calls[0].url.searchParams.has("ids")).toBe(false);
    expect(res.headers["cache-control"]).toMatch(/s-maxage=21600/);
  });

  it("batches ids in groups of 50", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `p${i}`);
    const f = mockFetch([{
      match: () => true,
      respond: (u) => ({ body: cdsEnvelope("policies", u.searchParams.get("ids").split(",").map(pol)) }),
    }]);
    const { req, res } = mockReqRes({ ids: ids.join(",") });
    await policies(req, res);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0].url.searchParams.get("ids").split(",")).toHaveLength(50);
    expect(f.calls[2].url.searchParams.get("ids").split(",")).toHaveLength(20);
    expect(Object.keys(res.json)).toHaveLength(120);
    expect(res.headers["cache-control"]).toMatch(/s-maxage=3600/);
  });

  it("ignores stray commas / whitespace in ids", async () => {
    const f = mockFetch([{ match: () => true, respond: (u) => ({ body: cdsEnvelope("policies", u.searchParams.get("ids").split(",").map(pol)) }) }]);
    const { req, res } = mockReqRes({ ids: " a,,b, " });
    await policies(req, res);
    expect(f.calls[0].url.searchParams.get("ids")).toBe("a,b");
  });

  it("502s on upstream failure", async () => {
    mockFetch([{ match: () => true, respond: { status: 500, body: {} } }]);
    const { req, res } = mockReqRes({});
    await policies(req, res);
    expect(res.statusCode).toBe(502);
  });
});

describe("GET /api/meters", () => {
  const ckanOk = (result) => ({ body: { success: true, result } });
  const pkg = { title: "Parking Meters", name: "parking-meters", resources: [{ id: "csv-1", name: "meters.csv", datastore_active: false }, { id: "ds-1", name: "Parking Meters", datastore_active: true }] };

  it("discovers the datastore resource and emits GeoJSON points", async () => {
    const f = mockFetch([
      { match: (u) => u.pathname.endsWith("package_search"), respond: ckanOk({ results: [{ title: "Parking Tickets", resources: [] }, pkg] }) },
      { match: (u) => u.pathname.endsWith("datastore_search"), respond: ckanOk({ records: [
        { _id: 1, METER_ID: "A1", LONGITUDE: "-71.08", LATITUDE: "42.35" },
        { _id: 2, METER_ID: "A2", Longitude: -71.07, Latitude: 42.36 },
        { _id: 3, METER_ID: "bad", LONGITUDE: "", LATITUDE: "" },
        { _id: 4, METER_ID: "swapped", LONGITUDE: "42.35", LATITUDE: "-71.08" },
      ] }) },
    ]);
    const { req, res } = mockReqRes({});
    await meters(req, res);
    expect(res.statusCode).toBe(200);
    expect(f.calls[1].url.searchParams.get("resource_id")).toBe("ds-1");
    const fc = res.json;
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry.coordinates).toEqual([-71.08, 42.35]);
    expect(fc.features[0].properties.METER_ID).toBe("A1");
    expect(fc.meta.resource).toBe("ds-1");
  });

  it("errors clearly when no meter dataset is found", async () => {
    mockFetch([{ match: (u) => u.pathname.endsWith("package_search"), respond: ckanOk({ results: [{ title: "Parking Tickets", resources: [] }] }) }]);
    const { req, res } = mockReqRes({});
    await meters(req, res);
    expect(res.statusCode).toBe(502);
    expect(res.json.error).toMatch(/No datastore/);
  });

  it("surfaces CKAN success:false", async () => {
    mockFetch([{ match: () => true, respond: { body: { success: false } } }]);
    const { req, res } = mockReqRes({});
    await meters(req, res);
    expect(res.statusCode).toBe(502);
    expect(res.json.error).toMatch(/package_search failed/);
  });
});
