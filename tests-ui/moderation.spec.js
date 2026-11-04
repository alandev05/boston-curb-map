import { test, expect } from "@playwright/test";
import { openMap, findCurb, mockApi, curbZoneOf } from "./helpers.js";

test("moderators open the panel from the map, pick a correction to see its curb, and accept it", async ({ page }) => {
  const queue = [];
  const calls = await mockApi(page, {
    "GET /api/review": ({ headers }) => (headers["x-admin-token"] === "letmein" ? { submissions: queue } : { status: 401, json: { error: "wrong admin token" } }),
    "POST /api/review": () => ({ ok: true, rebuild: false }),
  });
  await openMap(page);
  // A correction for a curb that's drawn here, tapped where it's drawn.
  const hit = await findCurb(page);
  const [zone, , len] = await curbZoneOf(page, hit.id);
  const at = await page.evaluate(({ x, y }) => window.__map.unproject([x, y]).toArray(), hit);
  queue.push({ id: "22222222-2222-4222-8222-222222222222", created_at: new Date().toISOString(), kind: "correction", status: "pending", curb_zone_id: zone, curb_length: len,
    stretch_from: null, stretch_to: null, curb_lng: at[0], curb_lat: at[1], confirmations: 1, note: "loading zone mornings", based_on: "", photo_url: null,
    rules: [{ priority: 30, rules: [{ activity: "loading" }], time_spans: [{ days_of_week: ["mon"], time_of_day_start: "07:00", time_of_day_end: "11:00" }] }] });

  await page.getByRole("button", { name: "Review corrections" }).click();
  const panel = page.locator(".mod-panel");
  await panel.getByPlaceholder("Your name").fill("Tester");
  await panel.getByPlaceholder("Admin token").fill("nope");
  await panel.getByRole("button", { name: "Load" }).click();
  await expect(panel).toContainText("doesn't match");

  await panel.getByPlaceholder("Admin token").fill("letmein");
  await panel.getByRole("button", { name: "Load" }).click();
  await expect(panel.locator(".mod-item")).toHaveCount(1);
  await panel.locator(".mod-item-head").click();
  await expect(panel.locator(".mod-detail")).toContainText("Proposed");
  await expect.poll(() => page.evaluate(() => window.__map.getSource("mod-highlight")?._data?.features?.length || 0)).toBeGreaterThan(0);

  await panel.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(panel.locator(".mod-item")).toHaveCount(0);
  const post = calls.find((c) => c.key === "POST /api/review");
  expect(post.body).toMatchObject({ id: "22222222-2222-4222-8222-222222222222", decision: "accept", reviewer: "Tester" });
  expect(post.headers["x-admin-token"]).toBe("letmein");
});

test("/review opens the moderator panel", async ({ page }) => {
  await mockApi(page, { "GET /api/review": () => ({ status: 401, json: { error: "admin token required" } }) });
  await openMap(page, "/review");
  await expect(page.locator(".mod-panel")).toBeVisible();
  await expect(page.locator(".mod-panel").getByPlaceholder("Admin token")).toBeVisible();
});
