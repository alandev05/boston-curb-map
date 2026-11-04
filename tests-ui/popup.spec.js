import { test, expect } from "@playwright/test";
import { openMap, findCurb, tapCurb, mockApi } from "./helpers.js";

test("tapping a curb shows its day as a timeline, and Fix this curb", async ({ page }) => {
  await mockApi(page, { "GET /api/curb": () => ({ pending: [], confirms: 0 }) });
  await openMap(page);
  await tapCurb(page);
  const popup = page.locator("#popup");
  await expect(popup.locator(".verdict")).toBeVisible();
  await expect(popup.locator(".agenda li").first()).toBeVisible();
  await expect(popup.getByRole("button", { name: /Fix this curb/ })).toBeVisible();
  await expect(popup.getByText("Looks right")).toHaveCount(0);
  // Out to Street View (looking at the curb) and to directions, in new tabs.
  const sv = new URL(await popup.getByRole("link", { name: "Street View" }).getAttribute("href"));
  expect(sv.searchParams.get("map_action")).toBe("pano");
  expect(sv.searchParams.get("viewpoint")).toMatch(/^42\.\d+,-71\.\d+$/);
  expect(await popup.getByRole("link", { name: "Google Maps" }).getAttribute("href")).toMatch(/google\.com\/maps\/dir\/\?api=1&destination=42\.\d+,-71\.\d+/);
  expect(await popup.getByRole("link", { name: "Apple Maps" }).getAttribute("href")).toMatch(/maps\.apple\.com\/\?daddr=42\.\d+,-71\.\d+/);
  await expect(popup.locator(".go").first()).toHaveAttribute("target", "_blank");
});

test("a pending correction from someone else can be confirmed", async ({ page }) => {
  const calls = await mockApi(page, {
    "GET /api/curb": () => ({ pending: [{ id: "11111111-1111-4111-8111-111111111111", created_at: new Date().toISOString(), stretch: null, note: "sign says loading", confirmations: 0, mine: false,
      rules: [{ priority: 30, rules: [{ activity: "loading" }], time_spans: [{ days_of_week: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], time_of_day_start: "07:00", time_of_day_end: "11:00" }] }] }], confirms: 0 }),
    "POST /api/confirm": () => ({ ok: true }),
  });
  await openMap(page);
  await tapCurb(page);
  await expect(page.getByText("Correction pending review")).toBeVisible();
  await page.getByRole("button", { name: "Matches what I see" }).click();
  await expect(page.getByRole("button", { name: /Thanks/ })).toBeVisible();
  expect(calls.find((c) => c.key === "POST /api/confirm").body.submission_id).toBe("11111111-1111-4111-8111-111111111111");
});

test("curbs can't be hovered or tapped until station names show (zoom 13)", async ({ page }) => {
  await mockApi(page, { "GET /api/curb": () => ({ pending: [], confirms: 0 }) });
  await openMap(page);
  // A curb found at street zoom, then zoomed out to 12.6 around it: still drawn under the same pixel…
  const hit = await findCurb(page);
  const drawn = await page.evaluate(({ x, y }) => {
    const map = window.__map;
    map.jumpTo({ center: map.unproject([x, y]), zoom: 12.6 });
    map.jumpTo({ center: map.getCenter() }); // settle
    const c = map.project(map.getCenter());
    return new Promise((r) => map.once("idle", () => r({ x: c.x, y: c.y, n: map.queryRenderedFeatures([[c.x - 4, c.y - 4], [c.x + 4, c.y + 4]], { layers: ["zone-line"] }).length })));
  }, hit);
  expect(drawn.n).toBeGreaterThan(0);
  Object.assign(hit, drawn);
  await page.mouse.move(hit.x, hit.y);
  expect(await page.evaluate(() => window.__map.getCanvas().style.cursor)).toBe("");
  await page.mouse.click(hit.x, hit.y);
  await expect(page.locator("#popup")).toBeHidden(); // …but not pickable
  await page.evaluate(() => window.__map.jumpTo({ zoom: 13.2 }));
  await page.waitForFunction(() => window.__map.loaded());
  await page.mouse.click(hit.x, hit.y);
  await expect(page.locator("#popup")).toBeVisible();
});
