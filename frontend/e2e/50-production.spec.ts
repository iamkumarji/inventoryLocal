import { readFileSync } from "node:fs";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { currentStep, DEMO_PASSWORD, expectNoHorizontalScroll, loadAdmin, shot, signIn, totp } from "./helpers";

/*
 * Production, assets, collaboration and documents screens against a freshly seeded stack.
 * Setup data (roles, approval limits, items, opening stock, a sub-assembly BOM) is created
 * through the real API; everything the specs assert on is done through the UI.
 */

test.describe.configure({ mode: "serial" });

const RAHUL = "rahul.supervisor@demo.local"; // production supervisor: maker
const MEERA = "meera.planthead@demo.local"; // plant head: checker, approver, posts depreciation (MFA)
const PRIYA = "priya.requester@demo.local"; // gets a task assigned

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const firstOfMonth = () => `${today().slice(0, 8)}01`;

const state: {
  meeraSecret: string;
  meeraStep: number;
  ids: Record<string, string>;
  orderUrl: string;
  assetUrl: string;
} = { meeraSecret: "", meeraStep: 0, ids: {}, orderUrl: "", assetUrl: "" };

// --- API helpers (setup only) ---------------------------------------------------------------------

async function call<T = Record<string, unknown>>(page: Page, method: string, url: string, data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const csrf = (await page.context().cookies()).find((c) => c.name === "erp_csrf")?.value ?? "";
  const res = await page.request.fetch(url, { method, data, headers: { "X-CSRF-Token": decodeURIComponent(csrf), ...headers } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${url} -> ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function freshCode(page: Page, secret: string, used: number): Promise<{ code: string; step: number }> {
  while (currentStep() <= used) await page.waitForTimeout(1000);
  return { code: totp(secret), step: currentStep() };
}

/**
 * Like helpers.watchConsole, but a test can announce an API rejection it provokes on purpose
 * (the browser logs every 4xx response as a console error).
 */
function watch(page: Page) {
  const errors: string[] = [];
  let expected = 0;
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/status of 40[13]|WebSocket connection/.test(text)) return;
    if (expected > 0 && /status of 4\d\d/.test(text)) {
      expected -= 1;
      return;
    }
    errors.push(text);
  });
  return {
    expectRejection: () => { expected += 1; },
    assertClean: () => expect(errors, errors.join("\n")).toEqual([]),
  };
}

async function asUser(browser: Browser, email: string, opts: { secret?: string; used?: number; width?: number } = {}) {
  const context = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: 900 } });
  const page = await context.newPage();
  const watcher = watch(page);
  await signIn(page, email, DEMO_PASSWORD, opts.secret, opts.used);
  return { page, ...watcher, close: () => context.close() };
}

// --- UI helpers -----------------------------------------------------------------------------------

async function pickItem(page: Page, scope: Locator, label: string | RegExp, code: string) {
  await scope.getByLabel(label, { exact: typeof label === "string" }).click();
  await page.getByPlaceholder("Type a code or name").fill(code);
  await page.getByRole("option", { name: new RegExp(`^${code}`) }).click();
}

async function choose(page: Page, scope: Locator, label: string | RegExp, option: RegExp) {
  await scope.getByLabel(label, { exact: typeof label === "string" }).click();
  await page.getByRole("option", { name: option }).click();
}

async function pickPerson(page: Page, scope: Locator, label: string, name: string) {
  await scope.getByLabel(label, { exact: true }).click();
  await page.getByPlaceholder("Type a name or email").fill(name);
  await page.getByRole("option", { name: new RegExp(name) }).click();
}

/** Completes the two-step verification prompt if the action asked for one (sensitive actions). */
async function passStepUp(page: Page) {
  const stepUp = page.getByRole("dialog", { name: /Confirm it/ });
  if (await stepUp.isVisible({ timeout: 3000 }).catch(() => false)) {
    const fresh = await freshCode(page, state.meeraSecret, state.meeraStep);
    state.meeraStep = fresh.step;
    await stepUp.getByLabel("Verification code").fill(fresh.code);
    await stepUp.getByRole("button", { name: "Verify and continue" }).click();
  }
}

async function mobileCheck(page: Page, path: string, name: string) {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForTimeout(800); // let data-driven tables render
  await expectNoHorizontalScroll(page);
  await shot(page, name);
  await page.setViewportSize({ width: 1440, height: 900 });
}

// --- Setup ---------------------------------------------------------------------------------------

test("setup: modules, roles, approval limits, items, opening stock", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const admin = loadAdmin();
  await signIn(page, "admin@demo.local", admin.password, admin.secret, admin.lastStep);

  const flags = await call<Array<{ id: string; key: string; enabled_default: boolean }>>(page, "GET", "/api/v1/admin/feature-flags/");
  for (const mod of ["masterdata", "inventory", "manufacturing", "assets", "collaboration", "documents", "finance"]) {
    const flag = flags.find((f) => f.key === `module.${mod}`)!;
    if (!flag.enabled_default) await call(page, "PATCH", `/api/v1/admin/feature-flags/${flag.id}/`, { enabled_default: true });
  }

  const perms = await call<Array<{ code: string; module: string; action: string }>>(page, "GET", "/api/v1/authorization/permissions/");
  const opsCodes = perms
    .filter((p) => ["manufacturing", "assets", "collaboration", "documents", "inventory", "masterdata"].includes(p.module)
      || (p.module === "organization" && p.action === "read"))
    .map((p) => p.code);
  const ops = await call<{ id: string }>(page, "POST", "/api/v1/authorization/roles/", {
    code: "e2e_operations", name: "Plant operations (E2E)", description: "Production, assets, tasks and documents.", permission_codes: opsCodes, mfa_required: false,
  });
  const controls = await call<{ id: string }>(page, "POST", "/api/v1/authorization/roles/", {
    code: "e2e_controls", name: "Approval limits (E2E)", description: "Sets approval limits.",
    permission_codes: ["authorization.approval_limit.read", "authorization.approval_limit.manage"], mfa_required: false,
  });
  const me = await call<{ active_company_id: string; user: { organization_id: string } }>(page, "GET", "/api/v1/auth/me/");
  const company = me.active_company_id;
  state.ids.company = company;
  state.ids.opsRole = ops.id;
  for (const email of [RAHUL, MEERA, PRIYA]) {
    const users = await call<{ results: Array<{ id: string; email: string }> }>(page, "GET", `/api/v1/identity/users/?search=${encodeURIComponent(email)}`);
    const user = users.results.find((u) => u.email === email)!;
    state.ids[email] = user.id;
    await call(page, "POST", "/api/v1/authorization/role-assignments/", {
      user: user.id, role: ops.id, scope_type: "company", scope_id: company, include_descendants: true, reason: "E2E plant operations",
    });
  }
  await call(page, "POST", "/api/v1/authorization/role-assignments/", {
    // Approval limits are organization-wide settings, so this grant is at organization scope.
    user: state.ids[MEERA], role: controls.id, scope_type: "organization", scope_id: me.user.organization_id, include_descendants: true, reason: "E2E approval limits",
  });

  // Meera enrols two-step verification (approval limits and depreciation posting require it).
  const meera = await asUser(browser, MEERA);
  const setup = await call<{ secret: string }>(meera.page, "POST", "/api/v1/auth/mfa/totp/setup/");
  state.meeraSecret = setup.secret;
  let fresh = await freshCode(meera.page, setup.secret, 0);
  await call(meera.page, "POST", "/api/v1/auth/mfa/totp/confirm/", { code: fresh.code });
  state.meeraStep = fresh.step;
  const setLimit = (documentType: string) => call(meera.page, "POST", "/api/v1/authorization/approval-limits/", {
    role: ops.id, document_type: documentType, currency: "INR", max_amount: "10000000",
  });
  try {
    await setLimit("inventory.stock_adjustment");
  } catch (error) {
    if (!String(error).includes("mfa_required")) throw error;
    fresh = await freshCode(meera.page, setup.secret, state.meeraStep);
    await call(meera.page, "POST", "/api/v1/auth/step-up/", { code: fresh.code });
    state.meeraStep = fresh.step;
    await setLimit("inventory.stock_adjustment");
  }
  await setLimit("assets.asset");

  // Rahul sets up master data and opening stock (approved by Meera).
  const rahul = await asUser(browser, RAHUL);
  const tree = await call<{ companies: Array<{ id: string; branches: Array<{ facilities: Array<{ id: string; code: string }>; warehouses: Array<{ id: string; code: string }> }> }> }>(rahul.page, "GET", "/api/v1/organization/scope-tree/");
  const branches = tree.companies.find((c) => c.id === company)!.branches;
  const warehouse = (code: string) => branches.flatMap((b) => b.warehouses).find((w) => w.code === code)!.id;
  state.ids.rm = warehouse("PUN-RM");
  const nos = await call<{ id: string }>(rahul.page, "POST", "/api/v1/masterdata/uoms/", { code: "NOS", name: "Numbers", kind: "count", decimals: 0 });
  const category = async (code: string, name: string, group: string) =>
    (await call<{ id: string }>(rahul.page, "POST", "/api/v1/masterdata/item-categories/", { code, name, posting_group: group })).id;
  const rm = await category("RM", "Raw materials", "RM");
  const fg = await category("FG", "Finished and semi-finished", "FG");
  const spare = await category("SPARE", "Maintenance spares", "SPARE");
  const item = async (code: string, name: string, item_type: string, cat: string, extra: Record<string, unknown> = {}) =>
    (await call<{ id: string }>(rahul.page, "POST", "/api/v1/masterdata/items/", { code, name, item_type, category: cat, stock_uom: nos.id, is_stocked: true, ...extra })).id;
  state.ids.steel = await item("RM-STEEL", "Steel blank 3 mm", "raw_material", rm, { is_purchasable: true });
  state.ids.bolt = await item("RM-BOLT", "Hex bolt M8", "raw_material", rm, { is_purchasable: true });
  state.ids.sfg = await item("SFG-PLATE", "Pressed base plate", "semi_finished", fg, { is_manufactured: true });
  state.ids.fg = await item("FG-BRKT", "Mounting bracket", "finished_good", fg, { is_manufactured: true, is_saleable: true, standard_cost: "150" });
  state.ids.belt = await item("SP-BELT", "Press drive belt", "spare", spare, { is_purchasable: true });

  const adjustment = await call<{ id: string; version: number }>(rahul.page, "POST", "/api/v1/inventory/adjustments/", {
    company, warehouse: state.ids.rm, posting_date: today(), reason: "opening_balance", notes: "E2E opening stock",
    lines: [
      { item: state.ids.steel, quantity: "200", unit_cost: "40" },
      { item: state.ids.bolt, quantity: "500", unit_cost: "2" },
      { item: state.ids.sfg, quantity: "50", unit_cost: "90" },
      { item: state.ids.belt, quantity: "10", unit_cost: "350" },
    ],
  });
  const submitted = await call<{ version: number }>(rahul.page, "POST", `/api/v1/inventory/adjustments/${adjustment.id}/submit/`, { version: adjustment.version });
  const approved = await call<{ version: number }>(meera.page, "POST", `/api/v1/inventory/adjustments/${adjustment.id}/approve/`, { version: submitted.version });
  await call(rahul.page, "POST", `/api/v1/inventory/adjustments/${adjustment.id}/post/`, { version: approved.version }, { "Idempotency-Key": crypto.randomUUID() });

  // The sub-assembly's BOM (drafted by Rahul, approved by Meera) so the bracket explodes over two levels.
  const sfgBom = await call<{ id: string }>(rahul.page, "POST", "/api/v1/manufacturing/boms/", { item: state.ids.sfg, code: "BOM-SFG-PLATE", name: "Pressed base plate", is_active: true });
  const withVersion = await call<{ versions: Array<{ id: string }> }>(rahul.page, "POST", `/api/v1/manufacturing/boms/${sfgBom.id}/versions/`, {
    effective_from: firstOfMonth(), output_quantity: "1", notes: "E2E", components: [{ item: state.ids.steel, quantity: "2", scrap_pct: "0", issue_method: "manual" }], operations: [],
  });
  await call(meera.page, "POST", `/api/v1/manufacturing/boms/${sfgBom.id}/versions/${withVersion.versions[0].id}/approve/`);
  state.ids.sfgBom = sfgBom.id;
  await meera.close();
  await rahul.close();
});

// --- Manufacturing -------------------------------------------------------------------------------

test("work centre and BOM: second-person approval, self-approval refused, cycle shown, explosion", async ({ browser }) => {
  test.setTimeout(240_000);
  const rahul = await asUser(browser, RAHUL);
  const page = rahul.page;

  await page.goto("/manufacturing/work-centers");
  await page.getByRole("button", { name: "New work centre" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Code", { exact: true }).fill("PRESS-01");
  await dialog.getByLabel("Name", { exact: true }).fill("200 t power press");
  await choose(page, dialog, "Facility", /PUN-P1/);
  await dialog.getByLabel("Labour rate (₹/h)").fill("300");
  await dialog.getByLabel("Machine rate (₹/h)").fill("600");
  await dialog.getByLabel("Overhead rate (₹/h)").fill("120");
  await dialog.getByRole("button", { name: "Create work centre" }).click();
  await expect(page.getByRole("cell", { name: /^PRESS-01/ })).toBeVisible();
  await page.getByRole("button", { name: "Edit PRESS-01" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("200 t power press (line 1)");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("PRESS-01 saved")).toBeVisible();
  await expect(page.getByRole("cell", { name: /200 t power press \(line 1\)/ })).toBeVisible();
  await shot(page, "50-work-centres");

  await page.goto("/manufacturing/boms");
  await page.getByRole("button", { name: "New BOM" }).click();
  dialog = page.getByRole("dialog");
  await pickItem(page, dialog, "Manufactured item", "FG-BRKT");
  await expect(dialog.getByLabel("BOM code")).toHaveValue("BOM-FG-BRKT");
  await dialog.getByRole("button", { name: "Create BOM" }).click();
  await expect(page).toHaveURL(/\/manufacturing\/boms\/[0-9a-f-]+$/);
  const bomUrl = page.url();

  await page.getByRole("button", { name: "New version" }).click();
  dialog = page.getByRole("dialog");
  await pickItem(page, dialog, "Component 1", "SFG-PLATE");
  await dialog.getByRole("button", { name: "Add component" }).click();
  await pickItem(page, dialog, "Component 2", "RM-BOLT");
  await dialog.getByLabel("Quantity", { exact: true }).nth(1).fill("4");
  await dialog.getByLabel("Issue", { exact: true }).nth(1).click();
  await page.getByRole("option", { name: "Backflush" }).click();
  await dialog.getByRole("button", { name: "Add operation" }).click();
  await dialog.getByLabel("Operation 1", { exact: true }).fill("Press and weld");
  await choose(page, dialog, "Work centre", /PRESS-01/);
  await dialog.getByLabel("Setup min").fill("15");
  await dialog.getByLabel("Run min/unit").fill("3");
  await shot(page, "51-bom-new-version");
  await dialog.getByRole("button", { name: "Create draft version" }).click();
  await expect(page.getByRole("heading", { name: /Version 1/ })).toBeVisible();
  await expect(page.getByText("You drafted this version, so another person must approve it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve version 1" })).toBeDisabled();

  // The server refuses self-approval too (maker-checker), not just the UI.
  const bomId = bomUrl.split("/").pop()!;
  const bom = await call<{ versions: Array<{ id: string }> }>(page, "GET", `/api/v1/manufacturing/boms/${bomId}/`);
  const csrf = (await page.context().cookies()).find((c) => c.name === "erp_csrf")?.value ?? "";
  const self = await page.request.post(`/api/v1/manufacturing/boms/${bomId}/versions/${bom.versions[0].id}/approve/`, { headers: { "X-CSRF-Token": decodeURIComponent(csrf) } });
  expect(self.status()).toBe(403);
  const refusal = await self.json();
  expect(refusal.code).toBe("self_approval");
  expect(refusal.detail).toMatch(/can't approve .*you created/i);

  // A version that would make the sub-assembly contain the bracket is a cycle; the API's message is shown.
  await page.goto(`/manufacturing/boms/${state.ids.sfgBom}`);
  await page.getByRole("button", { name: "New version" }).click();
  dialog = page.getByRole("dialog");
  await pickItem(page, dialog, "Component 1", "FG-BRKT");
  rahul.expectRejection(); // 422 bom_cycle
  await dialog.getByRole("button", { name: "Create draft version" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/cycle/i);
  await shot(page, "52-bom-cycle-error");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  rahul.assertClean();
  await rahul.close();

  const meera = await asUser(browser, MEERA, { secret: state.meeraSecret, used: state.meeraStep });
  state.meeraStep = currentStep();
  await meera.page.goto(bomUrl);
  await meera.page.getByRole("button", { name: "Approve version 1" }).click();
  await expect(meera.page.getByText("Version 1 approved", { exact: true })).toBeVisible();
  await expect(meera.page.getByRole("heading", { name: /Version 1/ })).toContainText("Approved");
  await expect(meera.page.getByText(/Drafted by Rahul Deshmukh \(DEMO\) · approved by Meera Iyer \(DEMO\) \(you\)/)).toBeVisible();
  await meera.page.getByLabel("Quantity of FG-BRKT").fill("10");
  await meera.page.getByRole("button", { name: "Explode" }).click();
  const tree = meera.page.getByRole("list", { name: "Explosion tree" });
  await expect(tree).toContainText("SFG-PLATE");
  await expect(tree).toContainText("RM-STEEL");
  await expect(tree).toContainText("RM-BOLT");
  await shot(meera.page, "53-bom-approved-explosion");
  meera.assertClean();
  await meera.close();
});

test("production order from release to close, with costing and a comment mentioning a colleague", async ({ browser }) => {
  test.setTimeout(240_000);
  const rahul = await asUser(browser, RAHUL);
  const page = rahul.page;
  await page.goto("/manufacturing/orders");
  await page.getByRole("button", { name: "New order" }).click();
  const dialog = page.getByRole("dialog");
  await pickItem(page, dialog, "Item to make", "FG-BRKT");
  await dialog.getByLabel(/^Quantity/).fill("10");
  await choose(page, dialog, "Facility", /PUN-P1/);
  await choose(page, dialog, "Issue materials from", /PUN-RM/);
  await choose(page, dialog, "Work-in-progress warehouse", /PUN-WIP/);
  await choose(page, dialog, "Receive output into", /PUN-FG/);
  await dialog.getByRole("button", { name: "Create draft order" }).click();
  await expect(page).toHaveURL(/\/manufacturing\/orders\/[0-9a-f-]+$/);
  state.orderUrl = page.url();

  await page.getByRole("button", { name: "Check availability" }).click();
  await expect(page.getByText("Everything is available")).toBeVisible();
  await expect(page.getByRole("cell", { name: "RM-STEEL" })).toBeVisible();
  await shot(page, "54-order-draft-availability");

  await page.getByRole("button", { name: "Release and reserve materials" }).click();
  await expect(page.getByText(/Released as MO/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("MO");

  await page.getByRole("button", { name: "Issue materials" }).click();
  let step = page.getByRole("dialog");
  await expect(step.getByLabel("SFG-PLATE")).toHaveValue("10");
  await step.getByLabel("SFG-PLATE").fill("12");
  await step.getByRole("button", { name: "Issue to WIP" }).click();
  await expect(page.getByText("Materials issued to WIP")).toBeVisible();

  await page.getByRole("button", { name: "Record scrap" }).click();
  step = page.getByRole("dialog");
  await step.getByLabel("Quantity", { exact: true }).fill("1");
  await step.getByLabel("Reason", { exact: true }).fill("Plate bent in the press");
  await step.getByRole("button", { name: "Record scrap" }).click();
  await expect(page.getByText("Scrap recorded")).toBeVisible();

  await page.getByRole("button", { name: "Confirm 10" }).click();
  step = page.getByRole("dialog");
  await step.getByLabel("Minutes worked").fill("45");
  await step.getByLabel("Quantity completed").fill("10");
  await step.getByRole("button", { name: "Book time" }).click();
  await expect(page.getByText("Time booked on Press and weld")).toBeVisible();

  await page.getByRole("button", { name: "Receive output" }).click();
  step = page.getByRole("dialog");
  await expect(step.getByLabel("Quantity of FG-BRKT")).toHaveValue("10");
  await step.getByRole("button", { name: "Receive output" }).click();
  await expect(page.getByText("Output received")).toBeVisible();
  await expect(page.locator("header").getByText("Completed", { exact: true })).toBeVisible();
  await shot(page, "55-order-completed");

  await page.getByRole("button", { name: "Close order" }).click();
  step = page.getByRole("dialog");
  await expect(step).toContainText("SFG-PLATE: 1"); // the extra plate issued goes back to stores
  await step.getByRole("button", { name: "Close order" }).click();
  await expect(page.getByText("Order closed; the cost record is frozen")).toBeVisible();
  await expect(page.getByText("Closed", { exact: true }).first()).toBeVisible();
  const costing = page.locator("section", { has: page.getByRole("heading", { name: "Costing", exact: true }) });
  await expect(costing).toContainText("Unit cost");
  await expect(costing).toContainText("₹765.00"); // conversion: 45 min at ₹1,020/h (labour 300 + machine 600 + overhead 120)
  await expect(costing).toContainText(/Above standard|At or below standard/);

  // Comment with an @mention of the plant head.
  await page.getByLabel("Add a comment").pressSequentially("Closed with one plate scrapped, @Meer");
  await page.getByRole("option", { name: /Meera Iyer/ }).click();
  await expect(page.getByLabel("Add a comment")).toHaveValue(/@meera\.planthead@demo\.local $/);
  await page.getByLabel("Add a comment").pressSequentially("please review the variance.");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText(/1 mentioned person notified/)).toBeVisible();
  await expect(page.getByRole("list", { name: "Comments" })).toContainText("@meera.planthead@demo.local");
  await page.getByLabel("Add a comment").fill("Typo, ignore");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByRole("list", { name: "Comments" })).toContainText("Typo, ignore");
  await page.getByRole("list", { name: "Comments" }).locator("li", { hasText: "Typo, ignore" }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("list", { name: "Comments" })).toContainText("Comment removed.");
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByRole("list", { name: "Activity" })).toContainText("released");
  await shot(page, "56-order-closed-costing");
  rahul.assertClean();

  // Closed orders can't be cancelled (the action is for orders nothing has happened on).
  const orderId = state.orderUrl.split("/").pop()!;
  const csrf = (await page.context().cookies()).find((c) => c.name === "erp_csrf")?.value ?? "";
  const late = await page.request.post(`/api/v1/manufacturing/orders/${orderId}/cancel/`, { data: { reason: "Too late" }, headers: { "X-CSRF-Token": decodeURIComponent(csrf) } });
  expect(late.status()).toBe(409);

  // A second order is released, then cancelled before any work: its reservations are freed.
  await page.goto("/manufacturing/orders");
  await page.getByRole("button", { name: "New order" }).click();
  const second = page.getByRole("dialog");
  await pickItem(page, second, "Item to make", "FG-BRKT");
  await second.getByLabel(/^Quantity/).fill("5");
  await choose(page, second, "Facility", /PUN-P1/);
  await choose(page, second, "Issue materials from", /PUN-RM/);
  await choose(page, second, "Work-in-progress warehouse", /PUN-WIP/);
  await choose(page, second, "Receive output into", /PUN-FG/);
  await second.getByRole("button", { name: "Create draft order" }).click();
  await expect(page).toHaveURL(/\/manufacturing\/orders\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Release and reserve materials" }).click();
  await expect(page.getByText(/Released as MO/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel order" }).click();
  step = page.getByRole("dialog");
  await expect(step.getByRole("button", { name: "Cancel order" })).toBeDisabled();
  await step.getByLabel("Reason", { exact: true }).fill("Customer postponed the call-off");
  await shot(page, "56a-order-cancel");
  await step.getByRole("button", { name: "Cancel order" }).click();
  await expect(page.getByText(/^MO\/.+ cancelled$/)).toBeVisible();
  await expect(page.locator("header").getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(page.getByText("This order is cancelled. No further shop-floor actions.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
  rahul.assertClean();

  await mobileCheck(page, state.orderUrl, "57-order-mobile");
  await mobileCheck(page, "/manufacturing/orders", "58-orders-mobile");
  await mobileCheck(page, "/manufacturing/boms", "59-boms-mobile");
  await rahul.close();

  // Meera got the mention.
  const meera = await asUser(browser, MEERA, { secret: state.meeraSecret, used: state.meeraStep });
  state.meeraStep = currentStep();
  await meera.page.goto("/notifications?filter=all");
  const mention = meera.page.getByRole("link", { name: /mentioned you/ }).first();
  await expect(mention).toBeVisible();
  await expect(mention).toHaveAttribute("href", /^\/records\/manufacturing\.production_order\//);
  await mention.click();
  // /records/{type}/{id} forwards to the order screen, with the mentioning comment highlighted.
  await expect(meera.page).toHaveURL(new RegExp(`/manufacturing/orders/${orderId}\\?comment=`));
  const highlighted = meera.page.getByRole("list", { name: "Comments" }).locator("li[aria-current='true']");
  await expect(highlighted).toContainText("please review the variance.");
  await shot(meera.page, "56b-mention-followed");
  meera.assertClean();
  await meera.close();
});

// --- Assets ---------------------------------------------------------------------------------------

test("asset capitalized by a second person, then a depreciation run posted", async ({ browser }) => {
  test.setTimeout(240_000);
  const rahul = await asUser(browser, RAHUL);
  let page = rahul.page;
  await page.goto("/assets?tab=categories");
  await page.getByRole("button", { name: "New category" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Code", { exact: true }).fill("PM");
  await dialog.getByLabel("Name", { exact: true }).fill("Plant and machinery");
  await dialog.getByLabel("Useful life (months)").fill("120");
  await dialog.getByLabel("Salvage (% of cost)").fill("5");
  await dialog.getByRole("button", { name: "Create category" }).click();
  await expect(page.getByRole("cell", { name: /^PM ?Plant and machinery/ })).toBeVisible();
  await page.getByRole("button", { name: "Edit PM" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Plant and machinery (Pune)");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("PM saved")).toBeVisible();
  await expect(page.getByRole("cell", { name: /^PM ?Plant and machinery \(Pune\)/ })).toBeVisible();

  await page.getByRole("tab", { name: "Register" }).click();
  await page.getByRole("button", { name: "New asset" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Asset code").fill("AST-PRESS-01");
  await dialog.getByLabel("Name", { exact: true }).fill("200 t power press");
  await choose(page, dialog, "Category", /^PM/);
  await choose(page, dialog, "Facility", /PUN-P1/);
  await dialog.getByLabel("Cost (₹)").fill("1200000");
  await dialog.getByLabel("Acquired on").fill(firstOfMonth());
  await dialog.getByLabel("Put to use on").fill(firstOfMonth());
  await dialog.getByRole("button", { name: "Add asset" }).click();
  await expect(page).toHaveURL(/\/assets\/[0-9a-f-]+$/);
  state.assetUrl = page.url();
  await expect(page.getByText("You created this asset, so someone else must capitalize or approve it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Capitalize now" })).toBeDisabled();
  await shot(page, "60-asset-draft");
  rahul.assertClean();
  await rahul.close();

  const meera = await asUser(browser, MEERA, { secret: state.meeraSecret, used: state.meeraStep });
  state.meeraStep = currentStep();
  page = meera.page;
  await page.goto(state.assetUrl);
  await page.getByRole("button", { name: "Capitalize now" }).click();
  await expect(page.getByText("AST-PRESS-01 capitalized; journal posted")).toBeVisible();
  await expect(page.getByText("Capitalized", { exact: true }).first()).toBeVisible();

  await page.goto("/assets/depreciation");
  await page.getByRole("button", { name: "New run" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create draft run" }).click();
  await expect(page).toHaveURL(/\/assets\/depreciation\/[0-9a-f-]+$/);
  await expect(page.getByRole("link", { name: "AST-PRESS-01" })).toBeVisible();
  await shot(page, "61-depreciation-preview");
  await page.getByRole("button", { name: "Post run" }).click();
  await passStepUp(page);
  await expect(page.getByText(/posted: ₹/)).toBeVisible();
  await expect(page.getByText("Posted", { exact: true }).first()).toBeVisible();
  await shot(page, "62-depreciation-posted");

  const runUrl = page.url();

  await page.goto(state.assetUrl);
  await expect(page.getByText("Accumulated dep.")).toBeVisible();
  await shot(page, "63-asset-capitalized");

  // The run is reversed (book values restored), then the month is run and posted again.
  await page.goto(runUrl);
  await page.getByRole("button", { name: "Reverse" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason", { exact: true }).fill("Run before the month's additions were capitalized");
  await dialog.getByRole("button", { name: "Reverse run" }).click();
  await passStepUp(page);
  await expect(page.getByText("Run reversed; the month can be run again")).toBeVisible();
  await expect(page.getByText("Reversed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Run before the month's additions were capitalized")).toBeVisible();
  await shot(page, "63a-depreciation-reversed");
  await page.goto("/assets/depreciation");
  await page.getByRole("button", { name: "New run" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create draft run" }).click();
  await expect(page).toHaveURL(/\/assets\/depreciation\/[0-9a-f-]+$/);
  await expect(page.getByRole("link", { name: "AST-PRESS-01" })).toBeVisible();
  await page.getByRole("button", { name: "Post run" }).click();
  await passStepUp(page);
  await expect(page.getByText(/posted: ₹/)).toBeVisible();
  meera.assertClean();
  await mobileCheck(page, state.assetUrl, "64-asset-mobile");
  await mobileCheck(page, "/assets/depreciation", "65-depreciation-mobile");
  await mobileCheck(page, runUrl, "65a-run-mobile");
  await meera.close();

  // A second asset goes through submit -> approve (decided by another person), then is disposed of.
  const rahul2 = await asUser(browser, RAHUL);
  page = rahul2.page;
  await page.goto("/assets");
  await page.getByRole("button", { name: "New asset" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Asset code").fill("AST-COMP-01");
  await dialog.getByLabel("Name", { exact: true }).fill("Screw air compressor");
  await choose(page, dialog, "Category", /^PM/);
  await choose(page, dialog, "Facility", /PUN-P1/);
  await dialog.getByLabel("Cost (₹)").fill("350000");
  await dialog.getByLabel("Acquired on").fill(today());
  await dialog.getByLabel("Put to use on").fill(today());
  await dialog.getByRole("button", { name: "Add asset" }).click();
  await expect(page).toHaveURL(/\/assets\/[0-9a-f-]+$/);
  const compressorUrl = page.url();
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText("Submitted for capitalization approval")).toBeVisible();
  await expect(page.getByText("Waiting for an approver other than you.")).toBeVisible();
  rahul2.assertClean();
  await rahul2.close();

  const meera2 = await asUser(browser, MEERA, { secret: state.meeraSecret, used: state.meeraStep });
  state.meeraStep = currentStep();
  page = meera2.page;
  await page.goto(compressorUrl);
  await page.getByLabel("Comment", { exact: true }).fill("Give the location before capitalizing");
  await page.getByRole("button", { name: "Reject" }).click();
  await passStepUp(page);
  await expect(page.getByText("Capitalization rejected")).toBeVisible();
  await expect(page.locator("header").getByText("Rejected", { exact: true })).toBeVisible();
  meera2.assertClean();
  await meera2.close();

  const rahul3 = await asUser(browser, RAHUL);
  page = rahul3.page;
  await page.goto(compressorUrl);
  await page.getByRole("button", { name: "Edit" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Location").fill("Compressor room, bay 2");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Asset saved")).toBeVisible();
  await expect(page.locator("dd", { hasText: "Compressor room, bay 2" })).toBeVisible();
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText("Submitted for capitalization approval")).toBeVisible();
  rahul3.assertClean();
  await rahul3.close();

  const meera3 = await asUser(browser, MEERA, { secret: state.meeraSecret, used: state.meeraStep });
  state.meeraStep = currentStep();
  page = meera3.page;
  // Links from approval requests use /assets/assets/{id}; they forward to the asset screen.
  await page.goto(compressorUrl.replace("/assets/", "/assets/assets/"));
  await expect(page).toHaveURL(compressorUrl);
  await page.getByLabel("Comment", { exact: true }).fill("Within budget");
  await page.getByRole("button", { name: "Approve and capitalize" }).click();
  await passStepUp(page);
  await expect(page.getByText("AST-COMP-01 approved and capitalized")).toBeVisible();
  await expect(page.locator("header").getByText("Capitalized", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Dispose" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Proceeds (₹)").fill("300000");
  await expect(dialog.getByText("Loss ₹50,000.00")).toBeVisible();
  await dialog.getByLabel("Reason", { exact: true }).fill("Replaced under the energy-saving programme");
  await shot(page, "63b-asset-dispose");
  await dialog.getByRole("button", { name: "Dispose asset" }).click();
  await passStepUp(page);
  await expect(page.getByText("Disposed with a loss of ₹50,000.00")).toBeVisible();
  await expect(page.locator("header").getByText("Disposed", { exact: true })).toBeVisible();
  await expect(page.locator("dd", { hasText: "Loss ₹50,000.00" })).toBeVisible();
  await shot(page, "63c-asset-disposed");
  meera3.assertClean();
  await mobileCheck(page, "/assets", "65b-assets-mobile");
  await meera3.close();
});

test("maintenance: plan generates preventive work; a breakdown work order runs its full lifecycle", async ({ browser }) => {
  test.setTimeout(240_000);
  const rahul = await asUser(browser, RAHUL);
  const page = rahul.page;

  await page.goto("/assets/maintenance?tab=plans");
  await page.getByRole("button", { name: "New plan" }).click();
  let dialog = page.getByRole("dialog");
  await choose(page, dialog, "Asset", /AST-PRESS-01/);
  await dialog.getByLabel("Plan name").fill("Monthly press lubrication");
  await dialog.getByLabel("Every (days)").fill("30");
  await dialog.getByLabel("Next due on").fill(today());
  await dialog.getByLabel("Checklist").fill("Grease slide gibs\nCheck oil level");
  await dialog.getByRole("button", { name: "Create plan" }).click();
  await expect(page.getByRole("cell", { name: /^Monthly press lubrication/ })).toBeVisible();
  await page.getByRole("button", { name: "Generate work orders" }).click();
  await expect(page.getByText("1 preventive work order generated")).toBeVisible();
  await page.getByRole("button", { name: "Edit Monthly press lubrication" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Every (days)").fill("28");
  await dialog.getByRole("button", { name: "Save plan" }).click();
  await expect(page.getByText('Plan "Monthly press lubrication" saved')).toBeVisible();
  await shot(page, "66-maintenance-plans");

  await page.getByRole("tab", { name: "Meter readings" }).click();
  await choose(page, page.locator("body"), "Asset", /AST-PRESS-01/);
  await page.getByLabel("Reading", { exact: true }).fill("1250");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByText("Meter reading recorded")).toBeVisible();
  await expect(page.getByRole("cell", { name: "1,250" })).toBeVisible();

  await page.getByRole("tab", { name: "Work orders" }).click();
  await page.getByRole("button", { name: "New work order" }).click();
  dialog = page.getByRole("dialog");
  await choose(page, dialog, "Asset", /AST-PRESS-01/);
  await dialog.getByLabel("What's wrong / what to do").fill("Drive belt slipping under load");
  await dialog.getByRole("button", { name: "Open work order" }).click();
  await expect(page).toHaveURL(/\/assets\/work-orders\/[0-9a-f-]+$/);

  await page.getByRole("button", { name: "Start work" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start work" }).click();
  await expect(page.getByText("Work started")).toBeVisible();

  await page.getByRole("button", { name: "Issue spares" }).click();
  dialog = page.getByRole("dialog");
  await pickItem(page, dialog, "Spare 1", "SP-BELT");
  await choose(page, dialog, "From warehouse", /PUN-RM/);
  await dialog.getByRole("button", { name: "Issue spares" }).click();
  await expect(page.locator("[data-sonner-toast]", { hasText: "Spares issued" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "SP-BELT" })).toBeVisible();

  await page.getByRole("button", { name: "Complete", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Downtime (min)").fill("90");
  await dialog.getByLabel("Labour hours").fill("1.5");
  await dialog.getByRole("button", { name: "Complete work" }).click();
  await expect(page.getByText("Work order completed")).toBeVisible();

  await page.getByRole("button", { name: "Close work order" }).click();
  await expect(page.getByText("Work order closed")).toBeVisible();
  await expect(page.getByText("Closed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("90 min")).toBeVisible();
  await shot(page, "67-work-order-closed");
  const woUrl = page.url();

  // The generated preventive work order is cancelled (nothing was issued against it).
  await page.goto("/assets/maintenance?tab=work-orders");
  await page.getByRole("row", { name: /Preventive/ }).first().click();
  await expect(page).toHaveURL(/\/assets\/work-orders\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Checklist" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel work order" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason", { exact: true }).fill("Done together with the breakdown repair");
  await dialog.getByRole("button", { name: "Cancel work order" }).click();
  await expect(page.getByText("Work order cancelled")).toBeVisible();
  await expect(page.getByText("This work order is cancelled.")).toBeVisible();

  await page.goto(state.assetUrl);
  await page.getByLabel("Reading", { exact: true }).fill("1310");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByText("Current reading 1,310")).toBeVisible();
  const reliability = page.locator("section", { has: page.getByRole("heading", { name: "Reliability" }) });
  await expect(reliability).toContainText("1.5 h"); // MTTR from the 90-minute breakdown
  rahul.assertClean();
  await mobileCheck(page, woUrl, "68-work-order-mobile");
  await mobileCheck(page, "/assets/maintenance", "69-maintenance-mobile");
  await rahul.close();
});

// --- Collaboration -------------------------------------------------------------------------------

test("a task is assigned, then the assignee moves it through My tasks", async ({ browser }) => {
  test.setTimeout(180_000);
  const rahul = await asUser(browser, RAHUL);
  let page = rahul.page;
  await page.goto("/collaboration/tasks");
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title", { exact: true }).fill("Count bracket stock after the trial run");
  await dialog.getByLabel("Description", { exact: true }).fill("Physical count of FG-BRKT in PUN-FG.");
  await choose(page, dialog, "Priority", /High/);
  await pickPerson(page, dialog, "Assignee", "Priya");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByText("Task assigned to Priya Kulkarni (DEMO)")).toBeVisible();
  await expect(page).toHaveURL(/\/collaboration\/tasks\/[0-9a-f-]+$/);
  const taskUrl = page.url();
  await page.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog");
  await choose(page, edit, "Priority", /Urgent/);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Task saved")).toBeVisible();
  await expect(page.getByText("Urgent", { exact: true }).first()).toBeVisible();
  await shot(page, "70-task-detail");
  await page.goto("/collaboration/tasks");
  await expect(page.getByRole("cell", { name: /Count bracket stock after the trial run/ })).toBeVisible();
  await page.getByLabel("Search tasks").fill("bracket stock");
  await expect(page.getByRole("cell", { name: /Count bracket stock after the trial run/ })).toBeVisible();
  rahul.assertClean();

  const priya = await asUser(browser, PRIYA);
  const p = priya.page;
  await p.goto("/tasks");
  await expect(p.getByText("Count bracket stock after the trial run")).toBeVisible();
  await p.getByRole("button", { name: "Start: Count bracket stock after the trial run" }).click();
  await expect(p.getByText("Task started")).toBeVisible();
  await expect(p.getByRole("list", { name: "My tasks" })).toContainText("In progress");
  await shot(p, "71-my-tasks");
  await p.getByRole("button", { name: "Mark done: Count bracket stock after the trial run" }).click();
  await expect(p.getByText("Task done")).toBeVisible();
  await p.getByRole("tab", { name: "Done" }).click();
  await expect(p.getByRole("list", { name: "My tasks" })).toContainText("Count bracket stock after the trial run");
  priya.assertClean();
  await mobileCheck(p, "/tasks?filter=done", "72-my-tasks-mobile");
  await priya.close();

  page = rahul.page;
  await page.goto(taskUrl);
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();
  await page.goto("/collaboration/tasks?tab=rules");
  await page.getByRole("button", { name: "New rule" }).click();
  const rule = page.getByRole("dialog");
  await rule.getByLabel("Code", { exact: true }).fill("OVERDUE-24");
  await rule.getByLabel("Name", { exact: true }).fill("Remind after a day overdue");
  await rule.getByRole("button", { name: "Create rule" }).click();
  await expect(page.getByRole("cell", { name: /^Remind after a day overdue/ })).toBeVisible();
  await page.getByRole("button", { name: "Edit OVERDUE-24" }).click();
  await page.getByRole("dialog").getByLabel("Overdue by (hours)").fill("48");
  await page.getByRole("dialog").getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByText("Rule OVERDUE-24 saved")).toBeVisible();
  await expect(page.getByRole("cell", { name: "48 h" })).toBeVisible();

  // A second task is reassigned from the team view, then cancelled by its new assignee's manager.
  await page.goto("/collaboration/tasks");
  await page.getByRole("button", { name: "New task" }).click();
  const another = page.getByRole("dialog");
  await another.getByLabel("Title", { exact: true }).fill("Label the WIP rack");
  await pickPerson(page, another, "Assignee", "Priya");
  await another.getByRole("button", { name: "Create task" }).click();
  await expect(page).toHaveURL(/\/collaboration\/tasks\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Reassign" }).click();
  const reassign = page.getByRole("dialog");
  await pickPerson(page, reassign, "Assignee", "Meera");
  await reassign.getByRole("button", { name: /^Assign to Meera/ }).click();
  await expect(page.getByText("Assigned to Meera Iyer (DEMO)")).toBeVisible();
  await page.getByRole("button", { name: "Cancel task: Label the WIP rack" }).click();
  await expect(page.locator("header").getByText("Cancelled", { exact: true })).toBeVisible();

  // Record links for kinds of record without a screen say so instead of failing.
  await page.goto("/records/assets.maintenance_plan/00000000-0000-0000-0000-000000000000");
  await expect(page.getByText("This record can't be opened here")).toBeVisible();
  await mobileCheck(page, "/collaboration/tasks", "73-tasks-mobile");
  rahul.assertClean();
  await rahul.close();
});

// --- Documents -----------------------------------------------------------------------------------

test("a document is uploaded, gets a new version and is downloaded", async ({ browser }) => {
  test.setTimeout(180_000);
  const rahul = await asUser(browser, RAHUL);
  const page = rahul.page;
  await page.goto("/documents");
  await page.getByRole("button", { name: "Upload" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("File", { exact: true }).setInputFiles({ name: "press-sop.txt", mimeType: "text/plain", buffer: Buffer.from("Press safety SOP\nRevision 1\n") });
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("press-sop");
  await dialog.getByLabel("Title", { exact: true }).fill("Press safety SOP");
  await dialog.getByLabel("Category", { exact: true }).fill("sop");
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+$/);
  await expect(page.getByRole("list", { name: "Versions" })).toContainText("v1");

  await page.getByRole("button", { name: "New version" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("File", { exact: true }).setInputFiles({ name: "press-sop.txt", mimeType: "text/plain", buffer: Buffer.from("Press safety SOP\nRevision 2: two-hand control check added\n") });
  await dialog.getByRole("button", { name: "Upload version" }).click();
  await expect(page.getByText("Version 2 uploaded")).toBeVisible();
  await expect(page.getByRole("list", { name: "Versions" }).getByText("v2")).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download", exact: true }).click()]);
  expect(download.suggestedFilename()).toBe("press-sop.txt");
  expect(readFileSync((await download.path())!, "utf8")).toContain("Revision 2");
  const [older] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download version 1" }).click()]);
  expect(readFileSync((await older.path())!, "utf8")).toContain("Revision 1");

  await page.getByRole("button", { name: "Grant" }).click();
  dialog = page.getByRole("dialog");
  await pickPerson(page, dialog, "Person", "Meera");
  await dialog.getByRole("button", { name: "Grant access" }).click();
  await expect(page.getByRole("list", { name: "Access entries" })).toContainText("Meera Iyer (DEMO)");

  await page.getByLabel("Reason for the hold").fill("Incident investigation INC-104");
  await page.getByRole("switch", { name: /Legal hold/ }).click();
  await expect(page.getByText("Legal hold placed")).toBeVisible();
  await expect(page.getByText("Can't be deleted while a legal hold applies.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete document" })).toBeDisabled();
  await shot(page, "74-document-detail");
  const docUrl = page.url();

  // Retention: kept until a future date, which also blocks deletion once the hold is released.
  const keep = new Date();
  keep.setFullYear(keep.getFullYear() + 7);
  const keepIso = `${keep.getFullYear()}-${String(keep.getMonth() + 1).padStart(2, "0")}-${String(keep.getDate()).padStart(2, "0")}`;
  const governance = page.locator("section", { has: page.getByRole("heading", { name: "Retention and legal hold" }) });
  await governance.getByLabel("Keep until").fill(keepIso);
  await page.getByRole("button", { name: "Save retention" }).click();
  await expect(page.getByText(/^Kept until /)).toBeVisible();
  await page.getByLabel("Reason for releasing").fill("Investigation INC-104 closed");
  await page.getByRole("switch", { name: /Legal hold/ }).click();
  await expect(page.getByText("Legal hold released")).toBeVisible();
  await expect(page.locator("section", { has: page.getByRole("heading", { name: "Delete", exact: true }) })).toContainText(/Can't be deleted before \d/);
  await expect(page.getByRole("button", { name: "Delete document" })).toBeDisabled();

  // A document without retention or hold can be deleted.
  await page.goto("/documents");
  await page.getByRole("button", { name: "Upload" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("File", { exact: true }).setInputFiles({ name: "old-drawing.csv", mimeType: "text/csv", buffer: Buffer.from("part,rev\nBRKT,A\n") });
  await dialog.getByLabel("Title", { exact: true }).fill("Superseded bracket drawing");
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Delete document" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Document deleted")).toBeVisible();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByRole("cell", { name: /Press safety SOP/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Superseded bracket drawing/ })).toHaveCount(0);

  // Files attached from a record's side panel.
  await page.goto(state.orderUrl);
  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByLabel("Attach a file").setInputFiles({ name: "inspection-report.txt", mimeType: "text/plain", buffer: Buffer.from("10 of 10 brackets passed\n") });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByText("File attached")).toBeVisible();
  await expect(page.getByRole("list", { name: "Attachments" })).toContainText("inspection-report");
  const [attached] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download inspection-report" }).click()]);
  expect(readFileSync((await attached.path())!, "utf8")).toContain("10 of 10");
  await shot(page, "74a-order-attachment");
  // After a fresh load the access list and version history still name people (served by the API).
  await page.goto(docUrl);
  await expect(page.getByRole("list", { name: "Access entries" })).toContainText("Meera Iyer (DEMO)");
  await page.getByRole("button", { name: "Edit details" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Description", { exact: true }).fill("Two-hand control and guard interlock checks.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Details saved")).toBeVisible();
  await expect(page.locator("dd", { hasText: "Two-hand control and guard interlock checks." })).toBeVisible();
  await page.getByRole("list", { name: "Access entries" }).locator("li", { hasText: "Meera Iyer" }).getByRole("button", { name: "Revoke access" }).click();
  await expect(page.getByText("Access revoked")).toBeVisible();
  await page.goto("/documents");
  await page.getByLabel("Filter by category").fill("sop");
  await page.getByLabel("Filter by category").press("Enter");
  await expect(page).toHaveURL(/category=sop/);
  await expect(page.getByRole("cell", { name: /Press safety SOP/ })).toBeVisible();
  rahul.assertClean();
  await mobileCheck(page, docUrl, "75-document-mobile");
  await mobileCheck(page, "/documents", "76-documents-mobile");
  await rahul.close();
});
