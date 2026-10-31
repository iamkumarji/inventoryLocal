import { expect, test } from "@playwright/test";

import { DEMO_PASSWORD, shot, signIn, watchConsole } from "./helpers";

test.describe.configure({ mode: "serial" });

test("supervisor approves a single-step request; navigation reflects permissions", async ({ page }) => {
  const assertClean = watchConsole(page);
  await signIn(page, "rahul.supervisor@demo.local", DEMO_PASSWORD);
  // A plain approver sees no administration menus.
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Audit log" })).toHaveCount(0);
  await expect(page.getByText("Cutting inserts for CNC line 2 (DEMO)")).toBeVisible();
  await shot(page, "10-supervisor-home");

  await page.getByRole("link", { name: "Approvals" }).first().click();
  await expect(page.getByRole("tab", { name: /Waiting for me/ })).toHaveAttribute("data-state", "active");
  await shot(page, "11-approvals-inbox");
  await page.getByRole("link", { name: /Cutting inserts for CNC line 2/ }).click();
  await expect(page.getByRole("heading", { name: "Approval route" })).toBeVisible();
  await page.getByLabel("Comment").fill("Within budget for Q3.");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved by Rahul Deshmukh (DEMO)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await shot(page, "12-request-approved");
  assertClean();
});

test("plant head rejects the second step with a reason; requester sees outcomes", async ({ page, browser }) => {
  const assertClean = watchConsole(page);
  await signIn(page, "meera.planthead@demo.local", DEMO_PASSWORD);
  await page.goto("/approvals");
  await page.getByRole("link", { name: /Hydraulic press seal kit/ }).click();
  await expect(page.getByText("Approved by Rahul Deshmukh (DEMO)")).toBeVisible(); // step 1 history
  const reject = page.getByRole("button", { name: "Reject" });
  await expect(reject).toBeDisabled(); // a reason is required
  await page.getByLabel("Comment").fill("Get a second quotation before ordering.");
  await shot(page, "13-plant-head-deciding");
  await reject.click();
  await expect(page.getByText("Rejected by Meera Iyer (DEMO)")).toBeVisible();
  await expect(page.getByText("Get a second quotation before ordering.")).toBeVisible();
  assertClean();

  const requester = await browser.newPage();
  const assertRequesterClean = watchConsole(requester);
  await signIn(requester, "priya.requester@demo.local", DEMO_PASSWORD);
  await requester.goto("/approvals?tab=mine");
  await expect(requester.getByRole("row", { name: /Hydraulic press seal kit/ })).toContainText("Rejected");
  await expect(requester.getByRole("row", { name: /Cutting inserts/ })).toContainText("Approved");
  await shot(requester, "14-requester-my-requests");
  await requester.goto("/notifications?filter=all");
  await expect(requester.getByText(/rejected/).first()).toBeVisible();
  await shot(requester, "15-requester-notifications");
  assertRequesterClean();
  await requester.context().close();
});
