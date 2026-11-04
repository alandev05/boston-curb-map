import { test, expect } from "@playwright/test";
import { openMap, findCurb, mockApi } from "./helpers.js";

test("phone: search bar and chips up top, settings in a sheet, curb details in a bottom sheet", async ({ page }) => {
  await mockApi(page, { "GET /api/curb": () => ({ pending: [], confirms: 0 }) });
  await openMap(page);
  await expect(page.locator("#searchInput")).toBeVisible();
  await expect(page.locator("#chipRow .chip").first()).toBeVisible();
  await page.getByRole("button", { name: /Time and settings/ }).click();
  await expect(page.locator("#panel.open #dayBtn")).toBeVisible();
  await page.getByRole("button", { name: /Time and settings/ }).click();
  const hit = await findCurb(page);
  await page.mouse.click(hit.x, hit.y);
  const popup = page.locator("#popup");
  await expect(popup).toBeVisible();
  const box = await popup.boundingBox(), vp = page.viewportSize();
  expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(vp.height - 2); // pinned to the bottom
});
