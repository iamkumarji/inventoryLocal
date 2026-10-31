import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect as baseExpect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { currentStep, expectNoHorizontalScroll, loadAdmin, shot, signIn, totp, watchConsole } from "./helpers";

/**
 * Inventory, master data and quality, end to end against the real API.
 *
 * The admin creates three people (store keeper, stores supervisor, finance controller) and their roles
 * through the API; everything after that happens in the UI as those people, except setting up a
 * production order (another team's screens) to put finished goods on quality hold.
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });
// The dev server compiles each route on its first visit; allow for that.
const expect = baseExpect.configure({ timeout: 20_000 });

// Run state is saved so a single test can be re-run against the same data with E2E_INV_RESUME=1 and --grep.
const STATE_FILE = path.join(process.env.E2E_STATE_DIR ?? path.join(__dirname, ".state"), "inventory.json");
const saved = process.env.E2E_INV_RESUME === "1" && existsSync(STATE_FILE)
  ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as { RUN: string; ids: Record<string, string> }) : null;
const RUN = saved?.RUN ?? Date.now().toString(36).slice(-5).toUpperCase();
const TEMP = "Temp-Passw0rd-2026!";
const PASSWORD = "Stores-Passphrase-2026";
const KEEPER = { email: `keeper.${RUN.toLowerCase()}@e2e.local`, name: `Kavya Store ${RUN} (E2E)` };
const SUPERVISOR = { email: `supervisor.${RUN.toLowerCase()}@e2e.local`, name: `Suresh Supervisor ${RUN} (E2E)` };
const CONTROLLER = { email: `controller.${RUN.toLowerCase()}@e2e.local`, name: `Chitra Controller ${RUN} (E2E)` };
const C = {
  pcs: `PC${RUN}`, kg: `KG${RUN}`, rm: `RM${RUN}`, fg: `FG${RUN}`, hsn: `7318${String(parseInt(RUN, 36) % 10000).padStart(4, "0")}`,
  bolt: `BOLT-${RUN}`, bracket: `BRKT-${RUN}`, barcode: `890${parseInt(RUN, 36)}`,
};
const ids: Record<string, string> = saved?.ids ?? {};
let adminStep = 0;

test.afterEach(() => {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ RUN, ids }));
});

/* ------------------------------------------------------------------ API helpers (same session as the page) */

async function call(page: Page, method: string, path: string, body?: unknown, idem = false) {
  const csrf = (await page.context().cookies()).find((c) => c.name === "erp_csrf")?.value;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (method !== "GET" && csrf) headers["X-CSRF-Token"] = decodeURIComponent(csrf);
  if (idem) headers["Idempotency-Key"] = randomUUID();
  const res = await page.request.fetch(path, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status(), json: text ? JSON.parse(text) : null };
}

async function api(page: Page, method: string, path: string, body?: unknown, idem = false) {
  const r = await call(page, method, path, body, idem);
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

/** Retries once after a step-up when the API asks for a fresh MFA check. */
async function withStepUp(page: Page, secret: string, method: string, path: string, body?: unknown) {
  let r = await call(page, method, path, body);
  if (r.status === 403 && r.json?.type === "mfa_required") {
    while (currentStep() <= adminStep) await page.waitForTimeout(1000);
    adminStep = currentStep();
    await api(page, "POST", "/api/v1/auth/step-up/", { code: totp(secret) });
    r = await call(page, method, path, body);
  }
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

async function firstSignIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(TEMP);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function replaceTemporaryPassword(page: Page) {
  await expect(page).toHaveURL(/\/setup\/password/);
  await page.getByLabel("Temporary password").fill(TEMP);
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repeat new password").fill(PASSWORD);
  await page.getByRole("button", { name: "Save password and continue" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

async function as(browser: Browser, who: { email: string }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const assertClean = watchConsole(page);
  await signIn(page, who.email, PASSWORD);
  return { page, assertClean };
}

/** Opens a select by its label (inside `scope`, e.g. an open dialog) and picks an option from the portal. */
async function choose(page: Page, label: string | RegExp, option: string | RegExp, scope: Page | Locator = page) {
  // Client-side navigation keeps the previous page mounted but hidden; only act on what's visible.
  await scope.getByLabel(label, { exact: typeof label === "string" }).filter({ visible: true }).click();
  await page.getByRole("option", { name: option }).first().click();
}

async function pickItem(page: Page, label: string | RegExp, code: string, scope: Page | Locator = page) {
  await scope.getByLabel(label, { exact: typeof label === "string" }).filter({ visible: true }).click();
  await page.getByPlaceholder("Code, name or barcode").fill(code);
  await page.getByRole("option", { name: new RegExp(code) }).click();
}

const alert = (scope: Page | Locator, text: string | RegExp) => scope.getByRole("alert").filter({ hasText: text });

/** The value next to a label in a facts list. */
const fact = (scope: Locator, label: string) => scope.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");

/* ------------------------------------------------------------------ 1. Setup through the API */

test("admin enables the modules and sets up stores people, roles and approval limits", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const admin = loadAdmin();
  const assertClean = watchConsole(page);
  await signIn(page, "admin@demo.local", admin.password, admin.secret, admin.lastStep);
  adminStep = currentStep();
  const me = await api(page, "GET", "/api/v1/auth/me/");
  ids.company = me.active_company_id;
  ids.org = me.user.organization_id;

  // Modules ship switched off. Turn on the ones these screens need.
  const flags = await api(page, "GET", "/api/v1/admin/feature-flags/");
  for (const key of ["module.masterdata", "module.inventory", "module.quality", "module.manufacturing"]) {
    const flag = flags.find((f: { key: string }) => f.key === key);
    if (flag.enabled_default) continue;
    const r = await call(page, "PATCH", `/api/v1/admin/feature-flags/${flag.id}/`, { enabled_default: true });
    expect(r.status, `enabling ${key}: ${JSON.stringify(r.json)}`).toBe(200);
  }

  const roles: Record<string, string[]> = {
    keeper: [
      "inventory.batch.read", "inventory.location.read", "inventory.stock_balance.read", "inventory.stock_ledger.read",
      "inventory.stock_adjustment.create", "inventory.stock_adjustment.read", "inventory.stock_adjustment.update", "inventory.stock_adjustment.post",
      "inventory.stock_transfer.create", "inventory.stock_transfer.read", "inventory.stock_transfer.update", "inventory.stock_transfer.dispatch",
      "inventory.stock_transfer.receive", "inventory.stock_count.create", "inventory.stock_count.read", "inventory.stock_count.update",
      "masterdata.uom.create", "masterdata.uom.read", "masterdata.uom.update", "masterdata.item_category.create", "masterdata.item_category.read",
      "masterdata.item_category.update", "masterdata.hsn_code.create", "masterdata.hsn_code.read", "masterdata.hsn_code.update",
      "masterdata.item.create", "masterdata.item.read", "masterdata.item.update", "masterdata.item_policy.create", "masterdata.item_policy.read",
      "masterdata.item_policy.update", "quality.inspection.read", "quality.ncr.read", "quality.inspection_plan.read",
      "organization.warehouse.read", "organization.facility.read",
      "manufacturing.bom.create", "manufacturing.bom.read", "manufacturing.bom.update", "manufacturing.production_order.create",
      "manufacturing.production_order.read", "manufacturing.production_order.release", "manufacturing.production_order.receive",
    ],
    supervisor: [
      "inventory.batch.read", "inventory.location.read", "inventory.stock_balance.read", "inventory.stock_ledger.read",
      "inventory.stock_adjustment.create", "inventory.stock_adjustment.read", "inventory.stock_adjustment.update",
      "inventory.stock_adjustment.approve", "inventory.stock_adjustment.post", "inventory.stock_transfer.read", "inventory.stock_transfer.receive",
      "inventory.stock_count.read", "inventory.stock_count.update", "inventory.stock_count.approve",
      "masterdata.uom.read", "masterdata.item_category.read", "masterdata.hsn_code.read", "masterdata.item.read", "masterdata.item_policy.read",
      "quality.inspection.read", "quality.inspection.approve", "quality.ncr.read", "quality.ncr.update", "quality.inspection_plan.read",
      "quality.inspection_plan.create", "quality.inspection_plan.update", "organization.warehouse.read",
      "manufacturing.bom.read", "manufacturing.bom.approve",
    ],
    controller: ["authorization.approval_limit.read", "authorization.approval_limit.manage", "authorization.role.read"],
  };
  for (const [key, codes] of Object.entries(roles)) {
    const role = await api(page, "POST", "/api/v1/authorization/roles/", { code: `e2e_${key}_${RUN.toLowerCase()}`, name: `${key} ${RUN} (E2E)`, permission_codes: codes });
    ids[`role_${key}`] = role.id;
  }
  for (const [key, person] of Object.entries({ keeper: KEEPER, supervisor: SUPERVISOR, controller: CONTROLLER })) {
    const user = await api(page, "POST", "/api/v1/identity/users/", {
      email: person.email, full_name: person.name, default_company: ids.company, mfa_enforced: key === "controller", temporary_password: TEMP,
    }, true);
    ids[`user_${key}`] = user.id;
  }
  // Approval limits are organization-level, so the controller's grant is too.
  for (const [key, scope_type, scope_id] of [["keeper", "company", ids.company], ["supervisor", "company", ids.company], ["controller", "organization", ids.org]]) {
    await withStepUp(page, admin.secret, "POST", "/api/v1/authorization/role-assignments/", {
      user: ids[`user_${key}`], role: ids[`role_${key}`], scope_type, scope_id, reason: `E2E inventory ${RUN}`,
    });
  }
  const tree = await api(page, "GET", "/api/v1/organization/scope-tree/");
  for (const company of tree.companies) for (const branch of company.branches) {
    for (const w of branch.warehouses) ids[w.code] = w.id;
    for (const f of branch.facilities) ids[f.code] = f.id;
  }
  assertClean();

  // The controller enrols two-step verification at first sign-in, then sets the supervisor's limit.
  const ctl = await browser.newPage();
  const ctlClean = watchConsole(ctl);
  await firstSignIn(ctl, CONTROLLER.email);
  await expect(ctl).toHaveURL(/\/setup\/mfa/);
  await ctl.getByRole("button", { name: "Set up authenticator" }).click();
  const key = (await ctl.locator("p.select-all").innerText()).replace(/\s/g, "");
  await ctl.getByLabel("Verification code").pressSequentially(totp(key));
  await ctl.getByRole("button", { name: "Turn on two-step verification" }).click();
  await ctl.getByLabel("I've stored these codes somewhere safe").check();
  await ctl.getByRole("button", { name: "Continue" }).click();
  await replaceTemporaryPassword(ctl);
  await api(ctl, "POST", "/api/v1/authorization/approval-limits/", {
    role: ids.role_supervisor, document_type: "inventory.stock_adjustment", currency: "INR", max_amount: "10000000",
  });
  ctlClean();
  await ctl.close();

  for (const person of [KEEPER, SUPERVISOR]) {
    const p = await browser.newPage();
    const clean = watchConsole(p);
    await firstSignIn(p, person.email);
    await replaceTemporaryPassword(p);
    clean();
    await p.close();
  }
});

/* ------------------------------------------------------------------ 2. Master data */

test("store keeper sets up units, categories, HSN codes and items", async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, assertClean } = await as(browser, KEEPER);
  await expect(page.getByRole("link", { name: "Item setup" })).toBeVisible();

  await page.goto("/masterdata/setup");
  await expect(page.getByRole("heading", { level: 1, name: "Item setup" })).toBeVisible();
  for (const [code, name, kind, decimals] of [[C.pcs, "Pieces", "Count", "0 (whole units)"], [C.kg, "Kilogram", "Mass", "3"]]) {
    await page.getByRole("button", { name: "New unit" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Code").fill(code);
    await dialog.getByLabel("Name").fill(name);
    await choose(page, "Kind", kind, dialog);
    await choose(page, "Decimals", decimals, dialog);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("row", { name: new RegExp(code) })).toBeVisible();
  }
  await page.getByRole("tab", { name: "Conversions" }).click();
  await page.getByRole("button", { name: "New conversion" }).click();
  await choose(page, "From unit", new RegExp(`^${C.kg}$`), page.getByRole("dialog"));
  await page.getByRole("dialog").getByLabel("Factor").fill("0");
  await choose(page, "To unit", new RegExp(`^${C.pcs}$`), page.getByRole("dialog"));
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(alert(page.getByRole("dialog"), "above zero")).toBeVisible();
  await page.getByRole("dialog").getByLabel("Factor").fill("40");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("row", { name: new RegExp(`1 ${C.kg} = 40 ${C.pcs}`) })).toBeVisible();

  await page.getByRole("tab", { name: "Categories" }).click();
  for (const [code, name, group] of [[C.rm, "Raw material", "RM"], [C.fg, "Finished goods", "FG"]]) {
    await page.getByRole("button", { name: "New category" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Code").fill(code);
    await dialog.getByLabel("Name").fill(`${name} ${RUN}`);
    await dialog.getByLabel("Posting group").fill(group);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("row", { name: new RegExp(code) })).toBeVisible();
  }
  await page.getByRole("tab", { name: "HSN / SAC" }).click();
  await page.getByRole("button", { name: "New code" }).click();
  await page.getByRole("dialog").getByLabel("Code").fill(C.hsn);
  await page.getByRole("dialog").getByLabel("GST rate (%)").fill("18");
  await page.getByRole("dialog").getByLabel("Description").fill("Screws, bolts and nuts of iron or steel");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("row", { name: new RegExp(C.hsn) })).toContainText("18%");
  await shot(page, "20-inv-setup-hsn");

  // Items
  await page.goto("/masterdata/items");
  for (const it of [
    { code: C.bolt, name: `Hex bolt M10 ${RUN}`, type: "Raw material", cat: C.rm, flags: [] as string[] },
    { code: C.bracket, name: `Bracket assembly ${RUN}`, type: "Finished good", cat: C.fg, flags: ["Made in-house", "Inspect on receipt / output"] },
  ]) {
    await page.getByRole("button", { name: "New item" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Item code").fill(it.code);
    await sheet.getByLabel("Name").fill(it.name);
    await choose(page, "Item type", it.type, sheet);
    await choose(page, "Category", new RegExp(`${it.cat === C.rm ? "Raw material" : "Finished goods"} ${RUN}`), sheet);
    await choose(page, "Stock unit", new RegExp(`^${C.pcs}`), sheet);
    if (it.code === C.bolt) await choose(page, "HSN / SAC code", new RegExp(C.hsn), sheet);
    await sheet.getByLabel("Standard cost (₹)").fill("12.5");
    for (const f of it.flags) await sheet.getByLabel(f).check();
    if (it.code === C.bolt) await shot(page, "21-inv-item-new");
    await sheet.getByRole("button", { name: "Create item" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(it.code);
    ids[it.code] = page.url().split("/").pop()!;
    await page.goto("/masterdata/items");
  }
  // Barcode and per-warehouse reorder settings on the bolt
  await page.goto(`/masterdata/items/${ids[C.bolt]}`);
  await page.getByLabel("Barcode", { exact: true }).fill(C.barcode);
  await page.getByRole("button", { name: "Add barcode" }).click();
  await expect(page.getByText(C.barcode)).toBeVisible();
  await page.getByRole("button", { name: "Add warehouse" }).click();
  await choose(page, "Warehouse", /PUN-RM/, page.getByRole("dialog"));
  await page.getByRole("dialog").getByLabel("Reorder level").fill("20");
  await page.getByRole("dialog").getByLabel("Reorder quantity").fill("100");
  await page.getByRole("dialog").getByLabel("Lead time (days)").fill("7");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("row", { name: /PUN-RM/ })).toContainText("20");
  // No stock movements yet: the stock unit can still change.
  await expect(page.getByLabel("Stock unit")).toBeEnabled();
  await shot(page, "22-inv-item-detail");
  assertClean();
  await page.close();
});

/* ------------------------------------------------------------------ 3. Adjustments with maker-checker */

test("adjustment: keeper drafts and submits, supervisor can't approve their own, approves the keeper's, keeper posts", async ({ browser }) => {
  test.setTimeout(120_000);
  const keeper = await as(browser, KEEPER);
  let page = keeper.page;
  await page.goto("/inventory/adjustments");
  await page.getByRole("link", { name: "New adjustment" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New stock adjustment" })).toBeVisible();
  await choose(page, "Warehouse", /PUN-RM/);
  await page.getByLabel("Notes").fill(`Opening stock ${RUN}`);
  await pickItem(page, "Item", C.bolt);
  await page.getByLabel(/^Quantity/).fill("100");
  await page.getByLabel("Unit cost (₹)").fill("12.50");
  await shot(page, "23-inv-adjustment-new");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Unposted adjustment" })).toBeVisible();
  ids.adj = page.url().split("/").pop()!;
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("₹1,250.00").first()).toBeVisible();
  // The keeper can't approve: the action isn't offered.
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(page.getByText("An approver needs to approve this adjustment")).toBeVisible();
  keeper.assertClean();

  // Maker-checker: the supervisor drafts and submits their own write-off, then tries to approve it.
  const sup = await as(browser, SUPERVISOR);
  const own = await api(sup.page, "POST", "/api/v1/inventory/adjustments/", {
    company: ids.company, warehouse: ids["PUN-RM"], posting_date: new Date().toISOString().slice(0, 10), reason: "damage",
    notes: `Dropped crate ${RUN}`, lines: [{ item: ids[C.bolt], quantity: "-2" }],
  });
  await sup.page.goto(`/inventory/adjustments/${own.id}`);
  await sup.page.getByRole("button", { name: "Submit for approval" }).click();
  await sup.page.getByRole("button", { name: "Approve" }).click();
  await expect(alert(sup.page, "maker-checker")).toBeVisible();
  await shot(sup.page, "24-inv-adjustment-maker-checker");

  // The supervisor approves the keeper's adjustment.
  await sup.page.goto(`/inventory/adjustments/${ids.adj}`);
  await sup.page.getByRole("button", { name: "Approve" }).click();
  await expect(sup.page.getByText("Approved, not posted").first()).toBeVisible();
  sup.assertClean();
  await sup.page.close();

  // Back to the keeper, who posts it.
  page = keeper.page;
  await page.reload();
  await page.getByRole("button", { name: "Post to stock" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/ADJ\//);
  await expect(page.getByText("Posted", { exact: true }).first()).toBeVisible();
  await shot(page, "25-inv-adjustment-posted");
  await page.getByRole("link", { name: "Ledger entries" }).click();
  await expect(page.getByRole("row", { name: new RegExp(C.bolt) })).toContainText("+100");

  await page.goto("/inventory/adjustments");
  await expect(page.getByRole("row", { name: /Dropped crate|Damage/ }).first()).toContainText("Submitted");
  await shot(page, "26-inv-adjustments-list");
  keeper.assertClean();
  await page.close();
});

/* ------------------------------------------------------------------ 4. Stock on hand, scan, ageing */

test("stock on hand: filters, availability drill-down, barcode scan and ageing", async ({ browser }) => {
  const { page, assertClean } = await as(browser, KEEPER);
  await page.goto("/inventory/stock");
  await choose(page, "Warehouse", /PUN-RM/);
  const row = page.getByRole("row", { name: new RegExp(C.bolt) });
  await expect(row).toContainText("100");
  await expect(row).toContainText("₹1,250.00");
  await row.getByRole("button").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Available to issue")).toBeVisible();
  await expect(sheet.getByLabel("Availability")).toContainText(`100 ${C.pcs}`);
  await shot(page, "27-inv-availability");
  await page.keyboard.press("Escape");

  await page.getByLabel("Scan or type a code").fill(C.barcode);
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.getByTestId("scan-result")).toContainText(C.bolt);
  await page.getByRole("button", { name: "Show its stock" }).click();
  await expect(page).toHaveURL(new RegExp(`item=${ids[C.bolt]}`));
  await shot(page, "28-inv-stock");

  await page.getByRole("tab", { name: "Ageing" }).click();
  await expect(page.getByRole("row", { name: new RegExp(C.bolt) })).toContainText("100");
  await shot(page, "29-inv-ageing");
  assertClean();
  // An unknown code: item lookup and scan both answer 404 (Chrome logs those, so this runs after the console check).
  await page.getByLabel("Scan or type a code").fill("NO-SUCH-CODE-404");
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.getByText("Nothing matches")).toBeVisible();
  await page.close();
});

/* ------------------------------------------------------------------ 5. Transfers */

test("transfer: create, dispatch into transit, receive at the destination", async ({ browser }) => {
  const { page, assertClean } = await as(browser, KEEPER);
  await page.goto("/inventory/transfers");
  await page.getByRole("link", { name: "New transfer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New stock transfer" })).toBeVisible();
  await choose(page, "From warehouse", /PUN-RM/);
  await choose(page, "To warehouse", /CHK-RM/);
  await pickItem(page, "Item", C.bolt);
  await expect(page.getByText(`100 ${C.pcs} free to issue`)).toBeVisible();
  await page.getByLabel(/^Quantity/).fill("10");
  await page.getByRole("button", { name: "Save transfer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Draft transfer" })).toBeVisible();
  await page.getByRole("button", { name: "Dispatch" }).click();
  await expect(page.getByText("In transit", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/TRF\//);
  await shot(page, "30-inv-transfer-dispatched");
  await page.getByRole("button", { name: "Receive" }).click();
  await expect(page.getByText("Received", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Receive" })).toHaveCount(0);
  await page.goto("/inventory/transfers");
  await expect(page.getByRole("row", { name: /TRF\// }).first()).toContainText("Received");
  await shot(page, "31-inv-transfers");
  assertClean();
  await page.close();
});

/* ------------------------------------------------------------------ 6. Counts: blind entry, counter ≠ approver */

test("count: blind count hides system quantity from the counter; a counter can't approve; another approver posts", async ({ browser }) => {
  test.setTimeout(120_000);
  const keeper = await as(browser, KEEPER);
  let page = keeper.page;
  await page.goto("/inventory/counts");
  await page.getByRole("button", { name: "Start count" }).click();
  await choose(page, "Warehouse", /PUN-RM/, page.getByRole("dialog"));
  await expect(page.getByLabel("Blind count")).toBeChecked();
  await pickItem(page, "Limit to items (optional)", C.bolt, page.getByRole("dialog"));
  await page.getByRole("dialog").getByRole("button", { name: "Start count" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/CNT\//);
  ids.count1 = page.url().split("/").pop()!;
  await expect(page.getByText("Blind", { exact: true }).filter({ visible: true })).toBeVisible();
  // The counter sees no system quantity anywhere on the sheet.
  await expect(page.getByRole("columnheader", { name: "System" })).toHaveCount(0);
  await expect(page.getByText("90", { exact: true })).toHaveCount(0);
  await page.getByLabel(`Counted quantity for ${C.bolt}`).fill("88");
  await shot(page, "32-inv-count-blind-entry");
  await page.getByRole("button", { name: /Save counts/ }).click();
  await expect(page.getByText("1 of 1 lines")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and post" })).toHaveCount(0);
  await expect(page.getByText("Counted: waiting for approval")).toBeVisible();

  // A second, open count at Chakan that the supervisor will count themselves.
  await page.goto("/inventory/counts");
  await page.getByRole("button", { name: "Start count" }).click();
  await choose(page, "Warehouse", /CHK-RM/, page.getByRole("dialog"));
  await page.getByLabel("Blind count").click();
  await page.getByRole("dialog").getByRole("button", { name: "Start count" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/CNT\//);
  ids.count2 = page.url().split("/").pop()!;
  keeper.assertClean();
  await page.close();

  const sup = await as(browser, SUPERVISOR);
  page = sup.page;
  await page.goto(`/inventory/counts/${ids.count2}`);
  await page.getByLabel(`Counted quantity for ${C.bolt}`).fill("10");
  await page.getByRole("button", { name: /Save counts/ }).click();
  await expect(page.getByText("1 of 1 lines")).toBeVisible();
  await page.getByRole("button", { name: "Approve and post" }).click();
  await expect(alert(page, "Counters can't approve")).toBeVisible();
  await shot(page, "33-inv-count-counter-refused");

  await page.goto(`/inventory/counts/${ids.count1}`);
  const review = page.getByRole("table", { name: "Count variances" });
  await expect(review.getByRole("row", { name: new RegExp(C.bolt) })).toContainText("90");
  await expect(review.getByRole("row", { name: new RegExp(C.bolt) })).toContainText("−2");
  await shot(page, "34-inv-count-review");
  await page.getByRole("button", { name: "Approve and post" }).click();
  await expect(page.getByText("Posted", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Posted variances" })).toBeVisible();
  sup.assertClean();
  await page.close();
});

/* ------------------------------------------------------------------ 7. Quality */

test("quality: output on hold is inspected, part released and part blocked; NCR closed; plan created", async ({ browser }) => {
  test.setTimeout(120_000);
  // Put finished goods on quality hold through production (manufacturing screens belong to another team).
  const keeper = await as(browser, KEEPER);
  const sup = await as(browser, SUPERVISOR);
  const today = new Date().toISOString().slice(0, 10);
  const bom = await api(keeper.page, "POST", "/api/v1/manufacturing/boms/", { item: ids[C.bracket], code: `BOM-${RUN}`, name: `Bracket ${RUN}` });
  const withVersion = await api(keeper.page, "POST", `/api/v1/manufacturing/boms/${bom.id}/versions/`, {
    output_quantity: "1", effective_from: today, components: [{ item: ids[C.bolt], quantity: "2", issue_method: "backflush" }],
  });
  await api(sup.page, "POST", `/api/v1/manufacturing/boms/${bom.id}/versions/${withVersion.versions.at(-1).id}/approve/`, {});
  const mo = await api(keeper.page, "POST", "/api/v1/manufacturing/orders/", {
    company: ids.company, facility: ids["PUN-P1"], item: ids[C.bracket], quantity: "5", planned_start: today, planned_end: today,
    source_warehouse: ids["PUN-RM"], wip_warehouse: ids["PUN-WIP"], output_warehouse: ids["PUN-FG"],
  });
  await api(keeper.page, "POST", `/api/v1/manufacturing/orders/${mo.id}/release/`, {});
  await api(keeper.page, "POST", `/api/v1/manufacturing/orders/${mo.id}/output/`, { on: today, quantity: "4" });

  // Release reserved 10 bolts; 4 brackets consumed 8, so 2 stay reserved.
  await keeper.page.goto(`/inventory/stock?warehouse=${ids["PUN-RM"]}&item=${ids[C.bolt]}`);
  await keeper.page.getByRole("row", { name: new RegExp(C.bolt) }).getByRole("button").click();
  const sheet = keeper.page.getByRole("dialog");
  await expect(sheet.getByLabel("Availability")).toContainText(`78 ${C.pcs}`);
  await expect(sheet.getByLabel("Availability")).toContainText(`80 ${C.pcs}`);
  await expect(fact(sheet, "Reserved")).toHaveText(`2 ${C.pcs}`);
  await shot(keeper.page, "35-inv-availability-reserved");
  keeper.assertClean();
  await keeper.page.close();

  const page = sup.page;
  await page.goto("/quality");
  const row = page.getByRole("row", { name: new RegExp(C.bracket) });
  await expect(row).toContainText("Waiting for decision");
  await shot(page, "36-quality-pending");
  await row.getByRole("button", { name: "Decide" }).click();
  const decide = page.getByRole("dialog");
  await expect(decide.getByText("Quantity on hold")).toBeVisible();
  await decide.getByLabel("Accepted").fill("3");
  await expect(decide.getByLabel("Rejected")).toHaveValue("1");
  await decide.getByRole("button", { name: "Record decision" }).click();
  await expect(alert(decide, "Say why material was rejected")).toBeVisible();
  await decide.getByLabel("Remarks").fill("Weld porosity on one bracket");
  await shot(page, "37-quality-decide");
  await decide.getByRole("button", { name: "Record decision" }).click();
  await expect(decide.getByText("Partly accepted")).toBeVisible();
  await page.keyboard.press("Escape");

  // Stock moved out of quality hold: 3 unrestricted, 1 blocked.
  await page.goto(`/inventory/stock?warehouse=${ids["PUN-FG"]}`);
  await page.getByRole("row", { name: new RegExp(C.bracket) }).getByRole("button").click();
  const avail = page.getByRole("dialog");
  await expect(avail.getByLabel("Availability")).toContainText(`3 ${C.pcs}`);
  await expect(fact(avail, "Blocked")).toHaveText(`1 ${C.pcs}`);
  await expect(fact(avail, "Quality hold")).toHaveText(`0 ${C.pcs}`);
  await page.keyboard.press("Escape");

  await page.goto("/quality?tab=ncrs");
  const ncr = page.getByRole("row", { name: /Weld porosity/ });
  await expect(ncr).toContainText("Open");
  await ncr.getByRole("button", { name: "Close" }).click();
  await choose(page, "Disposition", "Rework", page.getByRole("dialog"));
  await page.getByRole("dialog").getByLabel("Corrective action").fill("Re-weld and re-inspect; weld parameters reset on cell 2.");
  await page.getByRole("dialog").getByRole("button", { name: "Close NCR" }).click();
  await page.getByLabel("NCR status").click();
  await page.getByRole("option", { name: "Closed" }).click();
  await expect(page.getByRole("row", { name: /Weld porosity/ })).toContainText("Rework");
  await shot(page, "38-quality-ncrs");

  await page.goto("/quality?tab=plans");
  await page.getByRole("button", { name: "New plan" }).click();
  const planSheet = page.getByRole("dialog");
  await pickItem(page, "Item", C.bracket, planSheet);
  await choose(page, "Stage", "Final", planSheet);
  await planSheet.getByLabel("Sample size").fill("2");
  await planSheet.getByRole("button", { name: "Add parameter" }).click();
  await planSheet.getByLabel("Name", { exact: true }).fill("Hole pitch");
  await planSheet.getByLabel("Min", { exact: true }).fill("49.9");
  await planSheet.getByLabel("Max", { exact: true }).fill("50.1");
  await planSheet.getByLabel("Unit", { exact: true }).fill("mm");
  await page.getByRole("dialog").getByRole("button", { name: "Save plan" }).click();
  await expect(page.getByRole("row", { name: new RegExp(C.bracket) })).toContainText("Hole pitch");
  await shot(page, "39-quality-plans");
  sup.assertClean();
  await page.close();
});

/* ------------------------------------------------------------------ 8. Ledger and item locks */

test("ledger pages with a cursor; stock unit locks after movements; edits detect conflicts", async ({ browser }) => {
  const { page, assertClean } = await as(browser, KEEPER);
  await page.goto(`/inventory/ledger?size=10`);
  await expect(page.getByRole("button", { name: "Newer entries" })).toBeDisabled();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(11); // header + 10
  await page.getByRole("button", { name: "Older entries" }).click();
  await expect(page).toHaveURL(/cursor=/);
  await expect(page.getByRole("button", { name: "Newer entries" })).toBeEnabled();
  await page.getByRole("button", { name: "Newer entries" }).click();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(11);
  await page.goto(`/inventory/ledger?item=${ids[C.bolt]}&movement=count_loss`);
  await expect(page.getByRole("row", { name: /Count loss/ })).toContainText("−2");
  await shot(page, "40-inv-ledger");

  await page.goto(`/masterdata/items/${ids[C.bolt]}`);
  await expect(page.getByText("Has stock history", { exact: true })).toBeVisible();
  await expect(page.getByText("Fixed: the item has stock history")).toHaveCount(2);
  await expect(page.getByLabel("Stock unit")).toBeDisabled();
  await expect(page.getByLabel("Tracking")).toBeDisabled();
  await page.getByLabel("Name", { exact: true }).fill(`Hex bolt M10 x 40 ${RUN}`);
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByText("Item saved")).toBeVisible();
  assertClean();

  // Someone else saves first: the page reports the conflict instead of overwriting. (Chrome logs the 409.)
  const item = await api(page, "GET", `/api/v1/masterdata/items/${ids[C.bolt]}/`);
  await api(page, "PATCH", `/api/v1/masterdata/items/${ids[C.bolt]}/`, { description: "Zinc plated", version: item.version });
  await page.getByLabel("Name", { exact: true }).fill(`Hex bolt M10 x 45 ${RUN}`);
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(alert(page, "Someone changed this")).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue("Zinc plated");
  await page.close();
});

/* ------------------------------------------------------------------ 9. Phones */

test("every inventory, master data and quality screen fits a 375 px phone", async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, assertClean } = await as(browser, SUPERVISOR);
  await page.setViewportSize({ width: 375, height: 812 });
  const routes: Array<[string, string, string]> = [
    ["/inventory/stock", "Stock on hand", "50-m-stock"],
    ["/inventory/stock?tab=ageing", "Stock on hand", "51-m-ageing"],
    ["/inventory/ledger", "Stock ledger", "52-m-ledger"],
    ["/inventory/adjustments", "Stock adjustments", "53-m-adjustments"],
    [`/inventory/adjustments/${ids.adj}`, "ADJ", "54-m-adjustment"],
    ["/inventory/adjustments/new", "New stock adjustment", "55-m-adjustment-new"],
    ["/inventory/transfers", "Stock transfers", "56-m-transfers"],
    ["/inventory/counts", "Stock counts", "57-m-counts"],
    [`/inventory/counts/${ids.count1}`, "CNT", "58-m-count"],
    ["/masterdata/items", "Items", "59-m-items"],
    [`/masterdata/items/${ids[C.bolt]}`, C.bolt, "60-m-item"],
    ["/masterdata/setup", "Item setup", "61-m-setup"],
    ["/quality?status=all", "Quality", "62-m-quality"],
  ];
  for (const [path, heading, name] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await shot(page, name);
  }
  await page.goto("/inventory/stock");
  await page.getByRole("row", { name: new RegExp(C.bolt) }).first().getByRole("button").click();
  await expect(page.getByRole("dialog").getByText("Available to issue")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, "63-m-availability");
  assertClean();
  await page.close();
});
