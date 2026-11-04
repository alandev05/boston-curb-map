// Browser tests (tests-ui/): the real site, built against mock city data, in Chromium. Every /api call is answered
// by the test itself, so no database or keys are needed. `npm run test:ui` (CI runs it on every push).
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests-ui",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: "http://localhost:4173", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } }, testIgnore: /phone\.spec/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /phone\.spec/ },
  ],
  webServer: { command: "npm run ui:serve", url: "http://localhost:4173", timeout: 180_000, reuseExistingServer: !process.env.CI },
});
