import { test, expect } from "@playwright/test";
import { openMap } from "./helpers.js";

test("pick another day and time; Now goes back to the clock", async ({ page }) => {
  await openMap(page);
  const chip = page.locator("#whenLabel");
  await expect(chip).toHaveText(/^Today /);
  await page.locator("#whenBtn").click();
  await page.locator("#dayBtn").click();
  await page.locator("#dayList li[data-i='2']").click();
  await expect(chip).not.toHaveText(/^Today /);
  await page.locator("#timeSlider").fill("600"); // 10:00 AM
  await expect(chip).toHaveText(/10:00\s?AM/);
  await page.getByRole("button", { name: /Now/ }).click();
  await expect(chip).toHaveText(/^Today /);
});
