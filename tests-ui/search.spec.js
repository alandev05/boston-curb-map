import { test, expect } from "@playwright/test";
import { openMap } from "./helpers.js";

const STREETS = [
  ["Tremont Street", "South End", -71.075, 42.342, -71.065, 42.352, []],
  ["Trinity Place", "Back Bay", -71.076, 42.347, -71.075, 42.348, []],
  ["Massachusetts Avenue", "Boston", -71.09, 42.33, -71.08, 42.35, [-71.085, 42.34, -71.083, 42.344, -71.081, 42.348]],
  ["Taylor Street", "South End", -71.07, 42.344, -71.069, 42.345, []],
  ["Tyler Street", "Chinatown", -71.061, 42.349, -71.06, 42.35, []],
  ["Tamworth Street", "Chinatown", -71.063, 42.351, -71.062, 42.352, []],
];

test("desktop: search suggests five streets from the first letter, Google-style, and flies to the pick", async ({ page }) => {
  await page.route("**/data/streets.json", (route) => route.fulfill({ json: STREETS }));
  await page.route("https://photon.komoot.io/**", (route) => route.fulfill({ json: { features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [-71.068, 42.346] }, properties: { name: "Tremont Village Apartments", district: "Bay Village", city: "Boston", osm_key: "building" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [-71.1, 42.37] }, properties: { name: "Tremont Diner", city: "Cambridge", osm_key: "amenity" } },
  ] } }));
  await openMap(page);
  const pill = page.locator("#search"), box = await pill.boundingBox(), panel = await page.locator("#panel").boundingBox();
  expect(box.x).toBeGreaterThan(panel.x + panel.width); // beside the panel
  const input = page.locator("#searchInput"), options = page.getByRole("option");
  await input.pressSequentially("t");
  await expect(options).toHaveCount(5); // from the first letter, five at most
  await input.pressSequentially("re");
  await expect(options.first()).toContainText("Tremont Street");
  await expect(options.first().locator("b")).toHaveText("Tre"); // the typed letters stand out
  await expect(page.getByRole("option", { name: /Tremont Village Apartments/ })).toBeVisible(); // a place, from the third letter
  await expect(page.getByRole("option", { name: /Cambridge/ })).toHaveCount(0); // Boston only
  await input.fill("");
  await input.pressSequentially("mass ave");
  await expect(options.first()).toContainText("Massachusetts Avenue");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page.locator(".maplibregl-marker")).toBeVisible();
  await page.waitForFunction(() => !window.__map.isMoving());
  expect(await page.evaluate(() => window.__map.getZoom())).toBeGreaterThan(16); // a long street: its nearest stretch, close up
});
