import { test, expect } from "@playwright/test";
import { openMap, tapCurb, mockApi } from "./helpers.js";

test("fix a curb: drag a handle to choose part of it, edit the rules, submit", async ({ page }) => {
  const calls = await mockApi(page, {
    "GET /api/curb": () => ({ pending: [], confirms: 0 }),
    "POST /api/submit": () => ({ status: 201, json: { id: "x", status: "pending" } }),
  });
  await openMap(page);
  await tapCurb(page);
  await page.getByRole("button", { name: /Fix this curb/ }).click();
  const handles = page.locator(".stretch-handle");
  await expect(handles).toHaveCount(2);
  await expect(page.locator(".ed-stretch b")).toHaveText(/Whole curb/);

  // Drag the first handle halfway toward the second.
  await page.waitForTimeout(800); // the map frames the curb first
  const [a, b] = [await handles.nth(0).boundingBox(), await handles.nth(1).boundingBox()];
  const from = { x: a.x + a.width / 2, y: a.y + a.height / 2 }, to = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (to.x - from.x) * 0.5, from.y + (to.y - from.y) * 0.5, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".ed-stretch b")).toHaveText(/\d+ m of \d+ m/);
  await expect(page.getByRole("button", { name: "Use the whole curb" })).toBeVisible();

  // Add a loading-zone rule and see it in the preview.
  const before = await page.locator(".rule-card").count();
  await page.getByRole("button", { name: "+ Add rule" }).click();
  await expect(page.locator(".rule-card")).toHaveCount(before + 1);
  const card = page.locator(".rule-card").last();
  await card.locator(".rc-head .dd-btn").click();
  await card.getByRole("button", { name: "Loading zone" }).click();
  await page.locator(".ed-days").getByRole("button", { name: "Mon" }).click();
  await expect(page.locator(".ed-preview .agenda")).toContainText("Loading");

  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByText("Thanks!")).toBeVisible();
  const sent = calls.find((c) => c.key === "POST /api/submit").body;
  expect(sent.kind).toBe("correction");
  expect(sent.stretch).toHaveLength(2);
  expect(sent.stretch[1] - sent.stretch[0]).toBeLessThan(sent.curb_length);
  expect(sent.rules.some((r) => r.rules[0].activity === "loading")).toBe(true);
});

test("cancel returns to the curb's popup and clears the handles", async ({ page }) => {
  await mockApi(page, { "GET /api/curb": () => ({ pending: [], confirms: 0 }) });
  await openMap(page);
  await tapCurb(page);
  await page.getByRole("button", { name: /Fix this curb/ }).click();
  await expect(page.locator(".stretch-handle")).toHaveCount(2);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".stretch-handle")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Fix this curb/ })).toBeVisible();
});
