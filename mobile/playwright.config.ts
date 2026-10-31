import { defineConfig, devices } from "@playwright/test";

/**
 * Drives the browser build of the mobile app (expo export --platform web) at phone size against a
 * real backend seeded with bootstrap_erp + seed_demo + e2e/setup_backend.py. See e2e/README.md.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  timeout: 120_000, // field flows wait through real retry backoffs
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8190",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    geolocation: { latitude: 18.5204, longitude: 73.8567 },
    permissions: ["geolocation"],
  },
  projects: [{ name: "phone", use: { ...devices["Pixel 7"], browserName: "chromium" } }],
});
