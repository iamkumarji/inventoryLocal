import { expect, test } from "@playwright/test";

import { expectNoHorizontalScroll, loadAdmin, shot, signIn, watchConsole } from "./helpers";

test("administration screens render real data", async ({ page }) => {
  test.setTimeout(90_000); // sign-in may wait up to 30 s for a fresh authenticator code
  const admin = loadAdmin();
  const assertClean = watchConsole(page);
  await signIn(page, "admin@demo.local", admin.password, admin.secret, admin.lastStep);

  await page.goto("/admin/users");
  await expect(page.getByRole("link", { name: /Priya Kulkarni \(DEMO\)/ })).toBeVisible();
  await shot(page, "20-users");
  await page.getByRole("link", { name: /Rahul Deshmukh/ }).click();
  await expect(page.getByRole("heading", { name: "Access grants" })).toBeVisible();
  await expect(page.getByText("demo_stores_supervisor")).toBeVisible();
  await shot(page, "21-user-detail");

  await page.goto("/admin/roles?kind=templates");
  await page.getByRole("link", { name: /System Administrator \(template\)/ }).click();
  await expect(page.getByText("Template, read-only")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Role: Manage" })).toBeDisabled();
  await shot(page, "22-role-matrix");

  await page.goto("/admin/access");
  await expect(page.getByRole("row", { name: /rahul.supervisor@demo.local/ })).toContainText("Pune works (DEMO)");
  await page.getByRole("button", { name: "Grant access" }).click();
  await expect(page.getByRole("dialog")).toContainText("Every grant is audited");
  await shot(page, "23-grant-dialog");
  await page.keyboard.press("Escape");

  await page.goto("/admin/organization");
  await expect(page.getByText("Raw material store (DEMO)")).toBeVisible();
  await shot(page, "24-organization");

  // Approval routes are financial controls: the System Administrator template deliberately can't
  // manage them (segregation of duties). The menu hides them and the server refuses the page.
  await expect(page.getByRole("link", { name: "Approval routes" })).toHaveCount(0);
  await page.goto("/admin/approval-routes");
  await expect(page.getByText("Not available")).toBeVisible();
  await shot(page, "25-approval-routes-denied");

  await page.goto("/admin/audit");
  await expect(page.getByRole("button", { name: "auth.login.success" }).first()).toBeVisible();
  await page.getByRole("button", { name: "approvals.step.rejected" }).first().click();
  await expect(page.getByRole("dialog")).toContainText("Get a second quotation");
  await shot(page, "26-audit-detail");
  await page.keyboard.press("Escape");
  // Verifying/managing the audit trail is reserved for auditors, not system administrators.
  await expect(page.getByRole("button", { name: "Verify integrity" })).toHaveCount(0);

  for (const [path, heading] of [["/admin/policies", "Policies"], ["/admin/sod", "Segregation of duties"],
    ["/admin/approval-limits", "Approval limits"], ["/admin/feature-flags", "Feature flags"], ["/admin/outbox", "Event outbox"],
    ["/account/security", "Account"]] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }
  await page.goto("/admin/policies");
  await shot(page, "27-policies");

  // Command palette
  await page.keyboard.press("Meta+k");
  await page.getByPlaceholder("Jump to a page, or search people…").fill("meera");
  await expect(page.getByRole("option", { name: /Meera Iyer/ })).toBeVisible();
  await shot(page, "28-command-palette");
  await page.keyboard.press("Escape");

  // Mobile layout
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/approvals?tab=all", "/admin/users", "/admin/access", "/admin/audit", "/notifications?filter=all", "/account/security"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
  await page.goto("/approvals?tab=all");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Users" })).toBeVisible();
  await shot(page, "29-mobile-nav");
  assertClean();
});
