import { test, expect } from "@playwright/test";
import { openMap, tapCurb, mockApi } from "./helpers.js";

test("tapping a curb shows its day as a timeline, and Fix this curb", async ({ page }) => {
  await mockApi(page, { "GET /api/curb": () => ({ pending: [], confirms: 0 }) });
  await openMap(page);
  await tapCurb(page);
  const popup = page.locator("#popup");
  await expect(popup.locator(".verdict")).toBeVisible();
  await expect(popup.locator(".agenda li").first()).toBeVisible();
  await expect(popup.getByRole("button", { name: /Fix this curb/ })).toBeVisible();
  await expect(popup.getByText("Looks right")).toHaveCount(0);
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
