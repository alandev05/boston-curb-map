// Shared steps for the browser tests. The map is exposed as window.__map; curbs come from the mock fixture.
import { expect } from "@playwright/test";

export async function openMap(page, path = "/") {
  await page.goto(path);
  await page.waitForFunction(() => window.__map && window.__map.loaded() && window.__map.getLayer("zone-line"), null, { timeout: 30_000 });
}

// Somewhere with curbs drawn, at street zoom; returns the pixel of a drawn curb with rules and its feature id.
export async function findCurb(page, { minParts = 1, center = [-71.06, 42.35], zoom = 16.5 } = {}) {
  const hit = await page.evaluate(async ({ minParts, center, zoom }) => {
    const map = window.__map;
    map.jumpTo({ center, zoom });
    await new Promise((r) => map.once("idle", r));
    const panel = document.querySelector("#panel")?.getBoundingClientRect();
    const parts = new Map();
    for (const f of map.queryRenderedFeatures({ layers: ["zone-line"] })) parts.set(f.id, (parts.get(f.id) || 0) + (f.geometry.type === "MultiLineString" ? f.geometry.coordinates.length : 1));
    for (let y = 120; y < innerHeight - 120; y += 6) for (let x = 40; x < innerWidth - 40; x += 6) {
      if (panel && x < panel.right + 10 && y < panel.bottom + 10 && innerWidth > 640) continue;
      const f = map.queryRenderedFeatures([x, y], { layers: ["zone-line"] })[0];
      if (f && f.properties.rs != null && parts.get(f.id) >= minParts) return { x, y, id: f.id };
    }
    return null;
  }, { minParts, center, zoom });
  expect(hit, "a drawn curb to tap").not.toBeNull();
  return hit;
}

export async function tapCurb(page, opts) {
  const hit = await findCurb(page, opts);
  await page.mouse.click(hit.x, hit.y);
  await expect(page.locator("#popup")).toBeVisible();
  return hit;
}

// Answer /api/* from the test. handlers: { "GET /api/curb": (req) => body, … }; requests are recorded.
export async function mockApi(page, handlers = {}) {
  const calls = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), key = `${req.method()} ${url.pathname}`;
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push({ key, url, body, headers: req.headers() });
    const h = handlers[key];
    if (!h) return route.fulfill({ status: 404, json: { error: "not mocked" } });
    const out = await h({ url, body, headers: req.headers() });
    return route.fulfill({ status: out?.status || 200, json: out?.json ?? out });
  });
  return calls;
}

// The city curb id behind a drawn feature (from the build's lookup shards).
export const curbZoneOf = (page, id) => page.evaluate(async (id) => {
  const m = await (await fetch("/data/manifest.json")).json();
  const shard = await (await fetch(`/data/curbs/${Math.floor(id / m.curb_shard)}.json?v=${m.version}`)).json();
  return shard[id % m.curb_shard];
}, id);
