import { expect, type Page, test } from "@playwright/test";

import { expectNoHorizontalScroll, loadAdmin, shot, signIn, watchConsole } from "./helpers";

/**
 * Multi-tenant platform, organization sign-in policy, MFA skip/turn-off and webhooks.
 * Runs after 01-admin-first-login (the DEMO admin has MFA). Needs `create_platform_operator
 * --email ops@demo.local --password 'Platform-Dev-Passw0rd!'` and dev settings (MFA skip grace).
 */
test.describe.configure({ mode: "serial", timeout: 150_000 }); // sign-ins wait for fresh authenticator codes

const OPS = "ops@demo.local";
const OPS_TEMP = "Platform-Dev-Passw0rd!";
const OPS_NEW = "Platform-Operator-Passphrase-2026";
const ACME_ADMIN = "owner@acme.example";
const ACME_NEW = "Acme-Owner-Passphrase-2026";
let acmeTemp = "";

async function changeTemporaryPassword(page: Page, temp: string, next: string) {
  await expect(page).toHaveURL(/\/setup\/password/);
  await page.getByLabel("Temporary password").fill(temp);
  await page.getByLabel("New password", { exact: true }).fill(next);
  await page.getByLabel("Repeat new password").fill(next);
  await page.getByRole("button", { name: /change password|save|continue/i }).click();
}

async function skipMfa(page: Page) {
  await expect(page).toHaveURL(/\/setup\/mfa/);
  await expect(page.getByText(/You can postpone this until/)).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
}

async function signOut(page: Page) {
  await page.context().clearCookies();
}

test("platform operator skips MFA for now, creates an organization, suspends and reactivates it", async ({ page }) => {
  const assertClean = watchConsole(page);
  await page.goto("/login");
  await page.getByLabel("Work email").fill(OPS);
  await page.getByLabel("Password").fill(OPS_TEMP);
  await page.getByRole("button", { name: "Sign in" }).click();
  await shot(page, "70-operator-mfa-skip");
  await skipMfa(page);
  await changeTemporaryPassword(page, OPS_TEMP, OPS_NEW);

  // Operators see the platform, not tenant work.
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link", { name: "Organizations" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Approvals" })).toHaveCount(0);
  await nav.getByRole("link", { name: "Organizations" }).click();
  await expect(page).toHaveURL(/\/platform/);
  await expect(page.getByRole("cell", { name: "DEMO", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Create organization" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Code", { exact: true }).fill("ACME");
  await form.getByLabel("Name", { exact: true }).fill("Acme Fabrication");
  await form.getByLabel("Company code").fill("ACME01");
  await form.getByLabel("Legal name").fill("Acme Fabrication Pvt Ltd");
  await form.getByLabel("Full name").fill("Acme Owner");
  await form.getByLabel("Work email").fill(ACME_ADMIN);
  await shot(page, "71-create-organization");
  await page.getByRole("dialog").getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { name: "Acme Fabrication is ready" })).toBeVisible();
  acmeTemp = (await page.getByRole("dialog").locator("code").innerText()).trim();
  expect(acmeTemp.length).toBeGreaterThanOrEqual(12);
  await page.getByRole("button", { name: "Done" }).click();
  const row = page.getByRole("row", { name: /ACME/ });
  await expect(row).toContainText("Active");

  await row.getByRole("button", { name: "Suspend" }).click();
  await page.getByLabel("Reason").fill("Trial ended");
  await page.getByRole("button", { name: "Suspend and sign everyone out" }).click();
  await expect(row).toContainText("Suspended");
  await row.getByRole("button", { name: "Reactivate" }).click();
  await page.getByLabel("Reason").fill("Subscription paid");
  await page.getByRole("dialog").getByRole("button", { name: "Reactivate" }).click();
  await expect(row).toContainText("Active");
  await shot(page, "72-organizations");
  await page.setViewportSize({ width: 375, height: 800 });
  await expectNoHorizontalScroll(page);
  assertClean();
});

test("new organization's admin is isolated from the DEMO organization", async ({ page }) => {
  const assertClean = watchConsole(page);
  await page.goto("/login");
  await page.getByLabel("Work email").fill(ACME_ADMIN);
  await page.getByLabel("Password").fill(acmeTemp);
  await page.getByRole("button", { name: "Sign in" }).click();
  await skipMfa(page);
  await changeTemporaryPassword(page, acmeTemp, ACME_NEW);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();

  await page.goto("/admin/users");
  await expect(page.getByText(ACME_ADMIN)).toBeVisible();
  await expect(page.getByText("admin@demo.local")).toHaveCount(0);
  await expect(page.getByText(/demo\.local/)).toHaveCount(0);

  await page.goto("/admin/organization");
  await expect(page.getByText("Acme Fabrication Pvt Ltd").first()).toBeVisible();
  await expect(page.getByText(/DEMO Manufacturing/)).toHaveCount(0);

  // Switching a module here doesn't touch other organizations (checked from DEMO in the next test).
  await page.goto("/admin/feature-flags");
  const integrations = page.getByRole("row", { name: /module\.integrations/ });
  await integrations.getByRole("switch").click();
  await expect(integrations.getByRole("switch")).toBeChecked();
  await shot(page, "73-acme-flags");
  assertClean();
});

test("DEMO admin sets sign-in policy; a user turns two-step sign-in on and off", async ({ page }) => {
  const assertClean = watchConsole(page);
  const admin = loadAdmin();
  await signIn(page, "admin@demo.local", admin.password, admin.secret, admin.lastStep);

  // ACME's switch didn't change DEMO's.
  await page.goto("/admin/feature-flags");
  await expect(page.getByRole("row", { name: /module\.integrations/ }).getByRole("switch")).not.toBeChecked();

  await page.goto("/admin/security");
  const everyone = page.getByRole("switch", { name: "Two-step sign-in for everyone" });
  await expect(everyone).not.toBeChecked();
  await everyone.click();
  await expect(everyone).toBeChecked();
  await expect(page.getByText(/Every user must set up an authenticator app/)).toBeVisible();
  await shot(page, "74-sign-in-security");
  await page.setViewportSize({ width: 375, height: 800 });
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // A staff member is now asked to enrol (and may skip during the grace period).
  await signOut(page);
  await page.goto("/login");
  await page.getByLabel("Work email").fill("priya.requester@demo.local");
  await page.getByLabel("Password").fill("Demo-Passw0rd-2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await skipMfa(page);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();

  // Back to the default: relaxing needs the admin's recent code (verified at sign-in).
  await signOut(page);
  await signIn(page, "admin@demo.local", admin.password, admin.secret, admin.lastStep);
  await page.goto("/admin/security");
  await page.getByRole("switch", { name: "Two-step sign-in for everyone" }).click();
  await expect(page.getByRole("switch", { name: "Two-step sign-in for everyone" })).not.toBeChecked();
  assertClean();
});

test("webhooks: add an endpoint, see its secret once, send a test, inspect the delivery, rotate", async ({ page }) => {
  const assertClean = watchConsole(page);
  const admin = loadAdmin();
  await signIn(page, "admin@demo.local", admin.password, admin.secret, admin.lastStep);
  await page.goto("/admin/feature-flags");
  const integrations = page.getByRole("row", { name: /module\.integrations/ }).getByRole("switch");
  await expect(integrations).toBeVisible();
  if (!(await integrations.isChecked())) await integrations.click();
  await expect(integrations).toBeChecked();

  await page.goto("/admin/webhooks");
  await page.getByRole("button", { name: "Add endpoint" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Warehouse system");
  await dialog.getByLabel("Address (URL)").fill("https://wms.invalid/erp-hooks");
  await dialog.getByLabel("Events", { exact: true }).fill("inventory.*");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.getByRole("list", { name: "Subscribed events" })).toContainText("inventory.*");
  await dialog.getByRole("button", { name: /Add endpoint|Save|Create/ }).last().click();
  await expect(page.getByRole("heading", { name: "Endpoint added" })).toBeVisible();
  const secret = (await page.getByRole("dialog").locator("code").innerText()).trim();
  expect(secret).toMatch(/^whsec_/);
  await shot(page, "75-webhook-secret");
  await page.getByRole("link", { name: /Open endpoint/ }).click();
  await expect(page).toHaveURL(/\/admin\/webhooks\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { name: "Warehouse system" })).toBeVisible({ timeout: 30_000 });
  // Never shown again, and not left behind in the page either (previous routes stay mounted, hidden).
  await expect(page.getByText(secret)).toHaveCount(0);

  await page.getByRole("button", { name: /Send test/ }).click();
  // The worker tries it; the address doesn't resolve, so the delivery is recorded as failed with the reason.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/webhook\.ping/).first()).toBeVisible();
    await expect(page.getByText(/blocked|cannot resolve|failed/i).first()).toBeVisible();
  }).toPass({ timeout: 45_000 });
  await shot(page, "76-webhook-deliveries");
  await page.getByRole("button", { name: /Rotate secret/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Rotate secret" }).click();
  await expect(page.getByRole("heading", { name: "New signing secret" })).toBeVisible();
  const rotated = (await page.getByRole("dialog").locator("code").innerText()).trim();
  expect(rotated).toMatch(/^whsec_/);
  expect(rotated).not.toBe(secret);
  assertClean();
});
