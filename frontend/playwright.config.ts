import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a running stack (Django on :8000, Next on :3000) seeded with
 * `bootstrap_erp` + `seed_demo`. Specs run in order: the admin's first sign-in enrols MFA.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: process.env.E2E_ARTIFACTS ?? "test-results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
