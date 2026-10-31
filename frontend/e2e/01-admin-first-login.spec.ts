import { expect, test } from "@playwright/test";

import { currentStep, saveAdmin, shot, totp, watchConsole } from "./helpers";

const ADMIN = "admin@demo.local";
const TEMP = "Initial-Dev-Passw0rd!";
const NEW_PASSWORD = "Plant-Admin-Passphrase-2026";

test("admin first sign-in: enrol MFA, save recovery codes, replace temporary password", async ({ page }) => {
  const assertClean = watchConsole(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?next=%2F/);
  await shot(page, "01-login");

  await page.getByLabel("Work email").fill(ADMIN);
  await page.getByLabel("Password").fill("wrong-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible();

  await page.getByLabel("Password").fill(TEMP);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/setup\/mfa/);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const key = (await page.locator("p.select-all").innerText()).replace(/\s/g, "");
  expect(key).toMatch(/^[A-Z2-7]{32}$/);
  await shot(page, "02-mfa-setup");

  const enrolledStep = currentStep();
  await page.getByLabel("Verification code").pressSequentially(totp(key));
  await page.getByRole("button", { name: "Turn on two-step verification" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  await expect(page.locator("ol li")).toHaveCount(10);
  await shot(page, "03-recovery-codes");
  await page.getByLabel("I've stored these codes somewhere safe").check();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/\/setup\/password/);
  await page.getByLabel("Temporary password").fill(TEMP);
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Repeat new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Save password and continue" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening), System/);
  await expect(page.getByRole("link", { name: "Users" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Audit log" })).toBeVisible();
  await shot(page, "04-admin-home");
  saveAdmin({ secret: key, password: NEW_PASSWORD, lastStep: enrolledStep });
  assertClean();
});
