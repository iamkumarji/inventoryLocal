import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect as baseExpect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { currentStep, expectNoHorizontalScroll, loadAdmin, shot, signIn, totp } from "./helpers";

/**
 * Inventory, master data and quality, end to end against the real API.
 *
 * The admin switches the modules on in Admin › Feature flags and creates three people (store keeper, stores
 * supervisor, finance controller) and their roles through the API; everything after that happens in the UI as
 * those people, except: storage bins (there is no bin screen yet), a production order (another team's screens)
 * that puts finished goods on quality hold, and two adjustments set up to hit the self-approval and limit controls.
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
  bolt: `BOLT-${RUN}`, bracket: `BRKT-${RUN}`, paint: `PAINT-${RUN}`, gauge: `GAUGE-${RUN}`, old: `OLD-${RUN}`,
  barcode: `890${parseInt(RUN, 36)}`, batch: `PNT-${RUN}`, serial1: `GA-${RUN}-1`, serial2: `GA-${RUN}-2`,
  binA: `A01-${RUN}`, binB: `B01-${RUN}`,
};
const ids: Record<string, string> = saved?.ids ?? {};
let adminStep = 0;
/** Today's date where the browser and the server are (posting dates are local dates, not UTC). */
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => localDate(new Date());

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

/**
 * Fails the test on console errors or unhandled exceptions. 401/403 network logs are expected (refusals are
 * part of the workflows); other 4xx logs only for requests the test provokes on purpose (`allow(url pattern)`).
 */
function watchConsole(page: Page) {
  const errors: string[] = [];
  const allowed: RegExp[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    const url = m.location().url ?? "";
    if (/status of 40[13]|WebSocket connection/.test(text)) return;
    if (/status of 4\d\d/.test(text) && allowed.some((r) => r.test(url))) return;
    errors.push(`${text} ${url}`);
  });
  return {
    assertClean: () => expect(errors, errors.join("\n")).toEqual([]),
    allow: (pattern: RegExp) => allowed.push(pattern),
  };
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

async function as(browser: Browser, who: { email: string }, viewport?: { width: number; height: number }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const watch = watchConsole(page);
  await signIn(page, who.email, PASSWORD); // checks the main navigation, which phones fold into a menu
  if (viewport) await page.setViewportSize(viewport);
  return { page, assertClean: watch.assertClean, allow: watch.allow };
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

/** Changes a list filter and waits for it to reach the URL (filters live in the URL; see `useUrlState`). */
async function filterBy(page: Page, label: string | RegExp, option: string | RegExp) {
  const before = page.url();
  await choose(page, label, option);
  await expect.poll(() => page.url()).not.toBe(before);
}

const alert = (scope: Page | Locator, text: string | RegExp) => scope.getByRole("alert").filter({ hasText: text });

/** The value next to a label in a facts list. */
const fact = (scope: Locator, label: string) => scope.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");

/** A table row containing `text` (a code); exact codes keep e.g. BOLT rows apart from rows that mention it. */
const row = (scope: Page | Locator, text: string | RegExp) => scope.getByRole("row", { name: typeof text === "string" ? new RegExp(text) : text });

/** One line of a document form (`<li aria-label="Line n">`). */
const line = (page: Page, n: number) => page.getByRole("listitem", { name: `Line ${n}`, exact: true });

/* ------------------------------------------------------------------ 1. Setup */

test("admin enables the modules and sets up stores people, roles, bins and approval limits", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const admin = loadAdmin();
  const { assertClean } = watchConsole(page);
  await signIn(page, "admin@demo.local", admin.password, admin.secret, admin.lastStep);
  adminStep = currentStep();
  const me = await api(page, "GET", "/api/v1/auth/me/");
  ids.company = me.active_company_id;
  ids.org = me.user.organization_id;

  // Modules ship switched off. Turn on the ones these screens need, for this organization, on the Feature flags screen.
  await page.goto("/admin/feature-flags");
  await expect(page.getByRole("heading", { level: 1, name: "Feature flags" })).toBeVisible();
  for (const key of ["module.masterdata", "module.inventory", "module.quality", "module.manufacturing"]) {
    const toggle = page.getByRole("switch", { name: `${key} on by default` });
    if (await toggle.isChecked()) continue;
    await toggle.click();
    const code = page.getByLabel("Verification code");
    await expect.poll(async () => (await toggle.isChecked()) || (await code.isVisible())).toBe(true);
    if (await code.isVisible()) {
      while (currentStep() <= adminStep) await page.waitForTimeout(1000);
      adminStep = currentStep();
      await code.fill(totp(admin.secret));
      await page.getByRole("button", { name: "Verify and continue" }).click();
    }
    await expect(toggle).toBeChecked();
  }
  await shot(page, "19-inv-feature-flags");
  const flags: Array<{ key: string; enabled_default: boolean }> = await api(page, "GET", "/api/v1/admin/feature-flags/");
  expect(flags.filter((f) => f.key.startsWith("module.") && ["masterdata", "inventory", "quality", "manufacturing"].includes(f.key.slice(7)))
    .every((f) => f.enabled_default)).toBe(true);

  const roles: Record<string, string[]> = {
    keeper: [
      "inventory.batch.read", "inventory.location.read", "inventory.location.create", "inventory.stock_balance.read", "inventory.stock_ledger.read",
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

  // The controller enrols two-step verification at first sign-in (their account requires it), then sets the supervisor's limit.
  const ctl = await browser.newPage();
  const ctlWatch = watchConsole(ctl);
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
  ctlWatch.assertClean();
  await ctl.close();

  // The keeper and the supervisor don't have to use two-step sign-in: they go straight to replacing the temporary password.
  for (const person of [KEEPER, SUPERVISOR]) {
    const p = await browser.newPage();
    const { assertClean: clean } = watchConsole(p);
    await firstSignIn(p, person.email);
    await replaceTemporaryPassword(p);
    clean();
    await p.close();
  }
});

/* ------------------------------------------------------------------ 2. Master data */

test("store keeper sets up and edits units, conversions, categories and HSN codes", async ({ browser }) => {
  test.setTimeout(150_000);
  const { page, assertClean, allow } = await as(browser, KEEPER);
  await expect(page.getByRole("link", { name: "Item setup" })).toBeVisible();
  // Storage bins: there is no screen to manage them yet, so they're created through the API; the bin pickers use them below.
  for (const [code, wh] of [[C.binA, "PUN-RM"], [C.binB, "CHK-RM"]]) {
    const bin = await api(page, "POST", "/api/v1/inventory/locations/", { company: ids.company, warehouse: ids[wh], code, name: `Rack ${code.slice(0, 1)}`, kind: "bin" });
    ids[code] = bin.id;
  }

  await page.goto("/masterdata/setup");
  await expect(page.getByRole("heading", { level: 1, name: "Item setup" })).toBeVisible();
  const dialog = page.getByRole("dialog");
  for (const [code, name, kind, decimals] of [[C.pcs, "Pieces", "Count", "0 (whole units)"], [C.kg, "Kilogram", "Mass", "3"]]) {
    await page.getByRole("button", { name: "New unit" }).click();
    await expect(dialog.getByLabel("Code")).toHaveValue(""); // a second "New unit" starts blank
    await dialog.getByLabel("Code").fill(code);
    await dialog.getByLabel("Name").fill(name);
    await choose(page, "Kind", kind, dialog);
    await choose(page, "Decimals", decimals, dialog);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(row(page, code)).toBeVisible();
  }
  // A second unit with the same code: the API names the problem on the code field.
  allow(/\/masterdata\/uoms\//);
  await page.getByRole("button", { name: "New unit" }).click();
  await dialog.getByLabel("Code").fill(C.pcs);
  await dialog.getByLabel("Name").fill("Pieces again");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("A record with this code already exists.")).toBeVisible();
  await page.keyboard.press("Escape");
  // Edit: rename the kilogram unit; code and kind are fixed.
  await page.getByRole("button", { name: `Edit ${C.kg}`, exact: true }).click();
  await expect(dialog.getByLabel("Code")).toBeDisabled();
  await expect(dialog.getByLabel("Kind")).toBeDisabled();
  await dialog.getByLabel("Name").fill("Kilogram (bulk)");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, C.kg)).toContainText("Kilogram (bulk)");

  await page.getByRole("tab", { name: "Conversions" }).click();
  await page.getByRole("button", { name: "New conversion" }).click();
  await choose(page, "From unit", new RegExp(`^${C.kg}$`), dialog);
  await dialog.getByLabel("Factor").fill("0");
  await choose(page, "To unit", new RegExp(`^${C.pcs}$`), dialog);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(alert(dialog, "above zero")).toBeVisible();
  await dialog.getByLabel("Factor").fill("40");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row(page, `1 ${C.kg} = 40 ${C.pcs}`)).toBeVisible();
  await page.getByRole("button", { name: `Edit conversion ${C.kg} to ${C.pcs}` }).click();
  await expect(dialog.getByLabel("From unit")).toBeDisabled();
  await dialog.getByLabel("Factor").fill("42");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row(page, `1 ${C.kg} = 42 ${C.pcs}`)).toContainText("All items");

  await page.getByRole("tab", { name: "Categories" }).click();
  for (const [code, name, group] of [[C.rm, "Raw material", "RM"], [C.fg, "Finished goods", "FG"]]) {
    await page.getByRole("button", { name: "New category" }).click();
    await dialog.getByLabel("Code").fill(code);
    await dialog.getByLabel("Name").fill(`${name} ${RUN}`);
    await dialog.getByLabel("Posting group").fill(group);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(row(page, code)).toBeVisible();
  }
  // Edit: file finished goods under raw material (a parent), rename it.
  await page.getByRole("button", { name: `Edit ${C.fg}`, exact: true }).click();
  await dialog.getByLabel("Name").fill(`Finished goods ${RUN} (assemblies)`);
  await choose(page, "Parent category", `Raw material ${RUN}`, dialog);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, C.fg)).toContainText(`Raw material ${RUN}`);
  await expect(row(page, C.fg)).toContainText("(assemblies)");

  await page.getByRole("tab", { name: "HSN / SAC" }).click();
  await page.getByRole("button", { name: "New code" }).click();
  await dialog.getByLabel("Code").fill("73");
  await dialog.getByLabel("GST rate (%)").fill("18");
  await dialog.getByLabel("Description").fill("Screws, bolts and nuts of iron or steel");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(alert(dialog, "4 to 8 digits")).toBeVisible();
  await dialog.getByLabel("Code").fill(C.hsn);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row(page, C.hsn)).toContainText("18%");
  // Search narrows the list; a GST rate change is made once on the code.
  await page.getByLabel("Search HSN codes").fill(C.hsn);
  await page.getByLabel("Search HSN codes").press("Enter");
  await expect(page).toHaveURL(new RegExp(`q=${C.hsn}`));
  await expect(page.getByRole("table", { name: "HSN and SAC codes" }).getByRole("row")).toHaveCount(2);
  await page.getByRole("button", { name: `Edit HSN ${C.hsn}` }).click();
  await expect(dialog.getByLabel("Code")).toBeDisabled();
  await dialog.getByLabel("GST rate (%)").fill("12");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row(page, C.hsn)).toContainText("12%");
  await shot(page, "20-inv-setup-hsn");
  assertClean();
  await page.close();
});

test("store keeper creates items (plain, batch and serial tracked), filters the list, barcodes and reorder settings", async ({ browser }) => {
  test.setTimeout(150_000);
  const { page, assertClean, allow } = await as(browser, KEEPER);
  await page.goto("/masterdata/items");
  const sheet = page.getByRole("dialog");
  const items = [
    { code: C.bolt, name: `Hex bolt M10 ${RUN}`, type: "Raw material", cat: `Raw material ${RUN}`, uom: C.pcs, cost: "12.5", flags: [] as string[], hsn: true },
    { code: C.bracket, name: `Bracket assembly ${RUN}`, type: "Finished good", cat: `Finished goods ${RUN}`, uom: C.pcs, cost: "12.5", flags: ["Made in-house", "Inspect on receipt / output"] },
    { code: C.paint, name: `Primer paint ${RUN}`, type: "Consumable", cat: `Raw material ${RUN}`, uom: C.kg, cost: "300", flags: [], tracking: "Batch", shelf: "365" },
    { code: C.gauge, name: `Thread gauge ${RUN}`, type: "Spare", cat: `Raw material ${RUN}`, uom: C.pcs, cost: "1500", flags: [], tracking: "Serial number" },
    { code: C.old, name: `Old packing crate ${RUN}`, type: "Packaging", cat: `Raw material ${RUN}`, uom: C.pcs, cost: "40", flags: [] },
  ];
  for (const it of items) {
    await page.getByRole("button", { name: "New item" }).click();
    await sheet.getByLabel("Item code").fill(it.code);
    await sheet.getByLabel("Name").fill(it.name);
    await choose(page, "Item type", it.type, sheet);
    await choose(page, "Category", new RegExp(it.cat), sheet);
    await choose(page, "Stock unit", new RegExp(`^${it.uom}`), sheet);
    if (it.hsn) await choose(page, "HSN / SAC code", new RegExp(C.hsn), sheet);
    if (it.tracking) await choose(page, "Tracking", it.tracking, sheet);
    if (it.shelf) await sheet.getByLabel("Shelf life (days)").fill(it.shelf);
    await sheet.getByLabel("Standard cost (₹)").fill(it.cost);
    for (const f of it.flags) await sheet.getByLabel(f).check();
    if (it.code === C.paint) await shot(page, "21-inv-item-new");
    await sheet.getByRole("button", { name: "Create item" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(it.code);
    ids[it.code] = page.url().split("/").pop()!;
    await page.goto("/masterdata/items");
  }
  // A duplicate code is refused on the code field.
  allow(/\/masterdata\/items\//);
  await page.getByRole("button", { name: "New item" }).click();
  await sheet.getByLabel("Item code").fill(C.bolt);
  await sheet.getByLabel("Name").fill("Duplicate bolt");
  await choose(page, "Category", new RegExp(`Raw material ${RUN}`), sheet);
  await choose(page, "Stock unit", new RegExp(`^${C.pcs}`), sheet);
  await sheet.getByRole("button", { name: "Create item" }).click();
  await expect(sheet.getByText("A record with this code already exists.")).toBeVisible();
  await page.keyboard.press("Escape");

  // Retire the crate: inactive items drop out of the default list.
  await page.goto(`/masterdata/items/${ids[C.old]}`);
  await page.getByLabel("Active", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByText("Item saved")).toBeVisible();

  // List filters
  await page.goto("/masterdata/items");
  const table = page.getByRole("table", { name: "Items" });
  await page.getByLabel("Search items").fill(RUN);
  await page.getByLabel("Search items").press("Enter");
  await expect(page).toHaveURL(new RegExp(`q=${RUN}`));
  await expect(row(table, C.paint)).toBeVisible();
  await expect(row(table, C.old)).toHaveCount(0);
  await filterBy(page, "Tracking", "Batch");
  await expect(row(table, C.paint)).toContainText("Batch");
  await expect(row(table, C.bolt)).toHaveCount(0);
  await filterBy(page, "Tracking", "Serial number");
  await expect(row(table, C.gauge)).toBeVisible();
  await expect(row(table, C.paint)).toHaveCount(0);
  await filterBy(page, "Tracking", "Any tracking");
  await filterBy(page, "Item type", "Finished good");
  await expect(row(table, C.bracket)).toContainText("Inspected");
  await expect(table.getByRole("row")).toHaveCount(2);
  await filterBy(page, "Item type", "Any type");
  await filterBy(page, "Category", new RegExp(`Finished goods ${RUN}`));
  await expect(row(table, C.bracket)).toBeVisible();
  await expect(row(table, C.bolt)).toHaveCount(0);
  await filterBy(page, "Category", "Any category");
  await filterBy(page, "Status", "Inactive");
  await expect(row(table, C.old)).toContainText("Inactive");
  await expect(row(table, C.bolt)).toHaveCount(0);
  await filterBy(page, "Status", "All");
  await expect(row(table, C.old)).toBeVisible();
  await expect(row(table, C.bolt)).toBeVisible();
  await shot(page, "21-inv-items-filtered");

  // Barcodes (one for a pack in another unit) and per-warehouse reorder settings on the bolt
  await page.goto(`/masterdata/items/${ids[C.bolt]}`);
  await page.getByLabel("Barcode", { exact: true }).fill(C.barcode);
  await page.getByRole("button", { name: "Add barcode" }).click();
  await expect(page.getByText(C.barcode, { exact: true })).toBeVisible();
  await page.getByLabel("Barcode", { exact: true }).fill(`${C.barcode}9`);
  await choose(page, "Symbology", "QR code");
  await choose(page, "Unit", new RegExp(`^${C.kg}$`));
  await page.getByRole("button", { name: "Add barcode" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: `${C.barcode}9` })).toContainText(`QR code, unit ${C.kg}`);

  await page.getByRole("button", { name: "Add warehouse" }).click();
  const dialog = page.getByRole("dialog");
  await choose(page, "Warehouse", /PUN-RM/, dialog);
  await dialog.getByLabel("Reorder level").fill("20");
  await dialog.getByLabel("Reorder quantity").fill("100");
  await dialog.getByLabel("Lead time (days)").fill("7");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row(page, /PUN-RM/)).toContainText("20");
  // Settings for the same warehouse again: the API says which field is the problem.
  allow(/\/masterdata\/item-policies\//);
  await page.getByRole("button", { name: "Add warehouse" }).click();
  await choose(page, "Warehouse", /PUN-RM/, dialog);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("already has reorder settings for this warehouse")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Edit reorder settings for PUN-RM" }).click();
  await expect(dialog.getByLabel("Warehouse")).toBeDisabled();
  await expect(dialog.getByText("already has reorder settings")).toHaveCount(0); // the last attempt's error is gone
  await dialog.getByLabel("Reorder level").fill("25");
  await dialog.getByLabel("Maximum").fill("400");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, /PUN-RM/)).toContainText("25");
  await expect(row(page, /PUN-RM/)).toContainText("0 / 400");
  // No stock movements yet: the stock unit can still change.
  await expect(page.getByLabel("Stock unit")).toBeEnabled();
  await shot(page, "22-inv-item-detail");

  // An item-specific conversion (a bag of these bolts weighs less than the general rule says).
  await page.goto("/masterdata/setup?tab=conversions");
  await page.getByRole("button", { name: "New conversion" }).click();
  await pickItem(page, "Item (optional)", C.bolt, dialog);
  await choose(page, "From unit", new RegExp(`^${C.kg}$`), dialog);
  await dialog.getByLabel("Factor").fill("50");
  await choose(page, "To unit", new RegExp(`^${C.pcs}$`), dialog);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row(page, `1 ${C.kg} = 50 ${C.pcs}`)).toContainText(C.bolt);
  // The general rule exists already: refused with the units named.
  allow(/\/masterdata\/uom-conversions\//);
  await page.getByRole("button", { name: "New conversion" }).click();
  await choose(page, "From unit", new RegExp(`^${C.kg}$`), dialog);
  await dialog.getByLabel("Factor").fill("41");
  await choose(page, "To unit", new RegExp(`^${C.pcs}$`), dialog);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText(`A conversion from ${C.kg} to ${C.pcs} already exists.`)).toBeVisible();
  await page.keyboard.press("Escape");
  await shot(page, "22-inv-conversions");
  assertClean();
  await page.close();
});

/* ------------------------------------------------------------------ 3. Adjustments with maker-checker */

test("adjustment: keeper drafts batch, serial and bin lines; supervisor refused for own and over-limit, approves; keeper posts", async ({ browser }) => {
  test.setTimeout(180_000);
  const keeper = await as(browser, KEEPER);
  let page = keeper.page;
  await page.goto("/inventory/adjustments");
  await page.getByRole("link", { name: "New adjustment" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New stock adjustment" })).toBeVisible();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(alert(page, "Choose the warehouse.")).toBeVisible();
  await choose(page, "Warehouse", /PUN-RM/);
  await page.getByLabel("Notes").fill(`Opening stock ${RUN}`);
  await pickItem(page, "Item", C.bolt, line(page, 1));
  await line(page, 1).getByLabel(/^Quantity/).fill("100");
  await line(page, 1).getByLabel("Unit cost (₹)").fill("12.50");
  // Batch-tracked paint into a bin, with an expiry date
  await page.getByRole("button", { name: "Add line" }).click();
  await pickItem(page, "Item", C.paint, line(page, 2));
  await line(page, 2).getByLabel(/^Quantity/).fill("50");
  await line(page, 2).getByLabel("Unit cost (₹)").fill("300");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(alert(page, `Line 2: ${C.paint} is batch-tracked; enter the batch number.`)).toBeVisible();
  await line(page, 2).getByLabel("Batch number").fill(C.batch);
  await line(page, 2).getByLabel("Expires on").fill("2027-12-31");
  await choose(page, "Bin", new RegExp(C.binA), line(page, 2));
  // Serial-tracked gauges: one serial per unit
  await page.getByRole("button", { name: "Add line" }).click();
  await pickItem(page, "Item", C.gauge, line(page, 3));
  await line(page, 3).getByLabel(/^Quantity/).fill("2");
  await line(page, 3).getByLabel("Unit cost (₹)").fill("1500");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(alert(page, `Line 3: ${C.gauge} is serial-tracked; list the serial numbers.`)).toBeVisible();
  await line(page, 3).getByLabel("Serial numbers").fill(`${C.serial1}\n${C.serial2}`);
  // A line added by mistake is removed again.
  await page.getByRole("button", { name: "Add line" }).click();
  await expect(line(page, 4)).toBeVisible();
  await page.getByRole("button", { name: "Remove line 4" }).click();
  await expect(line(page, 4)).toHaveCount(0);
  await shot(page, "23-inv-adjustment-new");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Unposted adjustment" })).toBeVisible();
  ids.adj = page.url().split("/").pop()!;
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("₹19,250.00").first()).toBeVisible(); // 100 × 12.50 + 50 × 300 + 2 × 1,500
  // The keeper can't approve: the action isn't offered.
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(page.getByText("An approver needs to approve this adjustment")).toBeVisible();

  // A draft entered by mistake is cancelled with a reason; nothing posts.
  await page.goto("/inventory/adjustments/new");
  await choose(page, "Warehouse", /PUN-RM/);
  await choose(page, "Reason", "Loss");
  await expect(line(page, 1).getByLabel("Change")).toContainText("Remove stock");
  await page.getByLabel("Notes").fill(`Typed in twice ${RUN}`);
  await pickItem(page, "Item", C.bolt, line(page, 1));
  await line(page, 1).getByLabel(/^Quantity/).fill("1");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Unposted adjustment" })).toBeVisible();
  ids.adjCancelled = page.url().split("/").pop()!;
  await page.getByRole("button", { name: "Cancel adjustment" }).click();
  const cancel = page.getByRole("dialog");
  await cancel.getByRole("button", { name: "Cancel adjustment" }).click();
  await expect(alert(cancel, "Say why the adjustment is cancelled.")).toBeVisible();
  await cancel.getByLabel("Reason").fill("Entered twice by mistake");
  await shot(page, "23-inv-adjustment-cancel");
  await cancel.getByRole("button", { name: "Cancel adjustment" }).click();
  await expect(cancel).toHaveCount(0);
  await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("This adjustment was withdrawn before posting.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit for approval" })).toHaveCount(0);
  keeper.assertClean();

  // An opening balance far above the supervisor's ₹1,00,00,000 approval limit (set up through the API: 10 lakh bolts).
  const big = await api(page, "POST", "/api/v1/inventory/adjustments/", {
    company: ids.company, warehouse: ids["PUN-RM"], posting_date: today(), reason: "opening_balance",
    notes: `Bulk opening ${RUN}`, lines: [{ item: ids[C.bolt], quantity: "1000000", unit_cost: "12.5" }],
  });
  ids.adjBig = big.id;
  await api(page, "POST", `/api/v1/inventory/adjustments/${big.id}/submit/`, { version: big.version });

  // Maker-checker: the supervisor drafts and submits their own write-off, then tries to approve it.
  const sup = await as(browser, SUPERVISOR);
  const own = await api(sup.page, "POST", "/api/v1/inventory/adjustments/", {
    company: ids.company, warehouse: ids["PUN-RM"], posting_date: today(), reason: "damage",
    notes: `Dropped crate ${RUN}`, lines: [{ item: ids[C.bolt], quantity: "-2" }],
  });
  ids.adjOwn = own.id;
  await sup.page.goto(`/inventory/adjustments/${own.id}`);
  await sup.page.getByRole("button", { name: "Submit for approval" }).click();
  await sup.page.getByRole("button", { name: "Approve" }).click();
  const refusal = alert(sup.page, "You can't approve or decide something you created or submitted.");
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("self_approval");
  await shot(sup.page, "24-inv-adjustment-maker-checker");

  // Above the approval limit
  await sup.page.goto(`/inventory/adjustments/${ids.adjBig}`);
  await expect(sup.page.getByText("₹1,25,00,000.00").first()).toBeVisible();
  await sup.page.getByRole("button", { name: "Approve" }).click();
  const limit = alert(sup.page, "The amount is above your approval limit.");
  await expect(limit).toBeVisible();
  await expect(limit).toContainText("approval_limit");
  await expect(sup.page.getByText("Submitted", { exact: true }).first()).toBeVisible();
  await shot(sup.page, "24-inv-adjustment-over-limit");

  // The supervisor approves the keeper's adjustment.
  await sup.page.goto(`/inventory/adjustments/${ids.adj}`);
  await sup.page.getByRole("button", { name: "Approve" }).click();
  await expect(sup.page.getByText("Approved, not posted").first()).toBeVisible();
  sup.assertClean();
  await sup.page.close();

  // Back to the keeper, who posts it.
  page = keeper.page;
  await page.goto(`/inventory/adjustments/${ids.adj}`);
  await page.getByRole("button", { name: "Post to stock" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/ADJ\//);
  await expect(page.getByText("Posted", { exact: true }).first()).toBeVisible();
  const lines = page.getByRole("table", { name: "Adjustment lines" });
  await expect(row(lines, C.paint)).toContainText(C.batch);
  await expect(row(lines, C.paint)).toContainText("exp. 31 Dec 2027");
  await expect(row(lines, C.paint)).toContainText(C.binA);
  await expect(row(lines, C.gauge)).toContainText(`${C.serial1}, ${C.serial2}`);
  await shot(page, "25-inv-adjustment-posted");
  await page.getByRole("link", { name: "Ledger entries" }).click();
  await expect(row(page, C.bolt)).toContainText("+100");
  await expect(row(page, C.paint)).toContainText(`Batch ${C.batch}`);

  // List filters
  await page.goto("/inventory/adjustments");
  const table = page.getByRole("table", { name: "Stock adjustments" });
  await expect(row(table, /Damage/).first()).toContainText("Submitted");
  await filterBy(page, "Status", "Cancelled");
  await expect(page).toHaveURL(/status=cancelled/);
  await expect(row(table, /Loss/)).toContainText("Cancelled");
  await expect(row(table, /Opening balance/)).toHaveCount(0);
  await filterBy(page, "Status", "Any status");
  await filterBy(page, "Reason", "Damage");
  await expect(row(table, /Damage/)).toContainText("₹25.00");
  await expect(row(table, /Opening balance/)).toHaveCount(0);
  await filterBy(page, "Reason", "Any reason");
  await page.getByLabel("Search adjustments").fill(`Opening stock ${RUN}`);
  await page.getByLabel("Search adjustments").press("Enter");
  await expect(page).toHaveURL(/q=Opening/);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(row(table, /ADJ\//)).toContainText("Posted");
  await page.getByLabel("Search adjustments").fill("");
  await page.getByLabel("Search adjustments").press("Enter");
  await expect(page).not.toHaveURL(/q=/);
  await filterBy(page, "Warehouse", /CHK-RM/);
  await expect(page.getByText("No adjustments match")).toBeVisible();
  await filterBy(page, "Warehouse", "All warehouses");
  await expect(row(table, /Bulk|Opening balance/).first()).toBeVisible();
  await shot(page, "26-inv-adjustments-list");
  keeper.assertClean();
  await page.close();
});

/* ------------------------------------------------------------------ 4. Stock on hand, scan, ageing */

test("stock on hand: filters, availability drill-down, barcode, batch, serial and bin scans, ageing", async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, assertClean, allow } = await as(browser, KEEPER);
  await page.goto("/inventory/stock");
  await choose(page, "Warehouse", /PUN-RM/);
  const table = page.getByRole("table", { name: "Stock on hand by item and warehouse" });
  const bolt = row(table, C.bolt);
  await expect(bolt).toContainText("100");
  await expect(bolt).toContainText("₹1,250.00");
  await expect(row(table, C.paint)).toContainText(`50 ${C.kg}`);
  await expect(row(table, C.gauge)).toContainText("₹3,000.00");
  // Filters: search, item type, category; Clear resets them.
  await page.getByLabel("Search stock").fill(C.paint);
  await page.getByLabel("Search stock").press("Enter");
  await expect(page).toHaveURL(/q=PAINT/);
  await expect(row(table, C.paint)).toBeVisible();
  await expect(row(table, C.bolt)).toHaveCount(0);
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page).not.toHaveURL(/warehouse=/);
  await filterBy(page, "Item type", "Spare");
  await expect(row(table, C.gauge)).toBeVisible();
  await expect(row(table, C.bolt)).toHaveCount(0);
  await filterBy(page, "Item type", "Any type");
  await filterBy(page, "Category", new RegExp(`Raw material ${RUN}`));
  await expect(row(table, C.bolt)).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  await filterBy(page, "Warehouse", /PUN-RM/);

  await bolt.getByRole("button").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Available to issue")).toBeVisible();
  await expect(sheet.getByLabel("Availability")).toContainText(`100 ${C.pcs}`);
  await shot(page, "27-inv-availability");
  await sheet.getByRole("link", { name: "View movements" }).click();
  await expect(page).toHaveURL(new RegExp(`/inventory/ledger\\?item=${ids[C.bolt]}&warehouse=${ids["PUN-RM"]}`));
  await expect(row(page, /Adjustment in/)).toContainText("+100");

  await page.goto("/inventory/stock");
  const scan = async (code: string) => {
    await page.getByLabel("Scan or type a code").fill(code);
    await page.getByRole("button", { name: "Look up" }).click();
  };
  await scan(C.barcode);
  await expect(page.getByTestId("scan-result")).toContainText(`Item ${C.bolt}`);
  await page.getByRole("button", { name: "Show its stock" }).click();
  await expect(page).toHaveURL(new RegExp(`item=${ids[C.bolt]}`));
  await expect(table.getByRole("row")).toHaveCount(2);
  await shot(page, "28-inv-stock");
  await scan(C.batch);
  await expect(page.getByTestId("scan-result")).toContainText(`Batch of ${C.paint}, expires 31 Dec 2027`);
  await scan(C.serial1);
  await expect(page.getByTestId("scan-result")).toContainText(`Serial of ${C.gauge}`);
  await expect(page.getByTestId("scan-result")).toContainText("PUN-RM");
  await page.getByRole("button", { name: "Show its stock" }).click();
  await expect(page).toHaveURL(new RegExp(`item=${ids[C.gauge]}`));
  await expect(row(table, C.gauge)).toContainText("2");
  await scan(C.binA);
  await expect(page.getByTestId("scan-result")).toContainText("Storage bin in PUN-RM");
  await expect(page.getByRole("button", { name: "Show its stock" })).toHaveCount(0);
  allow(/\/inventory\/scan\//); // an unknown code is a 404
  await scan("NO-SUCH-CODE-404");
  await expect(page.getByText("Nothing matches")).toBeVisible();

  await page.getByRole("tab", { name: "Ageing" }).click();
  const ageing = page.getByRole("table", { name: "Stock ageing" });
  await expect(row(ageing, C.bolt)).toContainText("100");
  await expect(row(ageing, C.paint)).toContainText("50");
  await shot(page, "29-inv-ageing");
  await filterBy(page, "Warehouse", /CHK-RM/);
  await expect(row(ageing, C.bolt)).toHaveCount(0);
  await filterBy(page, "Warehouse", "All warehouses");
  const yesterday = localDate(new Date(Date.now() - 86_400_000));
  await page.getByLabel("As of").fill(yesterday);
  await expect(page).toHaveURL(new RegExp(`as_of=${yesterday}`));
  await expect(row(ageing, C.bolt)).toHaveCount(0); // nothing was on hand before today
  assertClean();
  await page.close();
});

/* ------------------------------------------------------------------ 5. Transfers */

test("transfer: plain, batch-from-bin and serial lines; dispatch into transit, receive at the destination; list filters", async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, assertClean } = await as(browser, KEEPER);
  await page.goto("/inventory/transfers");
  await page.getByRole("link", { name: "New transfer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New stock transfer" })).toBeVisible();
  await page.getByRole("button", { name: "Save transfer" }).click();
  await expect(alert(page, "Choose where the stock comes from and where it goes.")).toBeVisible();
  await choose(page, "From warehouse", /PUN-RM/);
  await choose(page, "To warehouse", /CHK-RM/);
  await page.getByLabel("Notes").fill(`Van MH12 ${RUN}`);
  await pickItem(page, "Item", C.bolt, line(page, 1));
  await expect(line(page, 1).getByText(`100 ${C.pcs} free to issue`)).toBeVisible();
  await line(page, 1).getByLabel(/^Quantity/).fill("10");
  await page.getByRole("button", { name: "Add line" }).click();
  await pickItem(page, "Item", C.paint, line(page, 2));
  await line(page, 2).getByLabel(/^Quantity/).fill("20");
  await page.getByRole("button", { name: "Save transfer" }).click();
  await expect(alert(page, "Line 2: choose the batch to move.")).toBeVisible();
  await choose(page, "Batch", new RegExp(C.batch), line(page, 2));
  await choose(page, "From bin", C.binA, line(page, 2));
  await choose(page, "To bin", C.binB, line(page, 2));
  await page.getByRole("button", { name: "Add line" }).click();
  await pickItem(page, "Item", C.gauge, line(page, 3));
  await line(page, 3).getByLabel(/^Quantity/).fill("1");
  await line(page, 3).getByLabel("Serial numbers").fill(C.serial1);
  await shot(page, "30-inv-transfer-new");
  await page.getByRole("button", { name: "Save transfer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Draft transfer" })).toBeVisible();
  ids.trf = page.url().split("/").pop()!;
  const lines = page.getByRole("table", { name: "Transfer lines" });
  await expect(row(lines, C.paint)).toContainText(C.batch);
  await expect(row(lines, C.paint)).toContainText(`${C.binA}${C.binB}`); // "A01 → B01": from bin, arrow, to bin
  await expect(row(lines, C.gauge)).toContainText(C.serial1);
  await page.getByLabel("Dispatched on").fill(today());
  await page.getByRole("button", { name: "Dispatch" }).click();
  await expect(page.getByText("In transit", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/TRF\//);
  await shot(page, "30-inv-transfer-dispatched");
  await page.getByRole("button", { name: "Receive" }).click();
  await expect(page.getByText("Received", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Receive" })).toHaveCount(0);

  await page.goto("/inventory/transfers");
  const table = page.getByRole("table", { name: "Stock transfers" });
  await expect(row(table, /TRF\//).first()).toContainText("Received");
  await filterBy(page, "Status", "Received");
  await filterBy(page, "From warehouse", /PUN-RM/);
  await filterBy(page, "To warehouse", /CHK-RM/);
  await expect(page).toHaveURL(/status=received/);
  await expect(row(table, /TRF\//)).toHaveCount(1);
  await filterBy(page, "Status", "In transit");
  await expect(page.getByText("No transfers match")).toBeVisible();
  await filterBy(page, "Status", "Any status");
  await shot(page, "31-inv-transfers");

  // The serial moved with the transfer.
  await page.goto("/inventory/stock");
  await page.getByLabel("Scan or type a code").fill(C.serial1);
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.getByTestId("scan-result")).toContainText("CHK-RM");
  assertClean();
  await page.close();
});

/* ------------------------------------------------------------------ 6. Counts: blind entry, counter ≠ approver */

test("count: blind count hides system quantity from the counter; found stock; a counter can't approve; another approver posts", async ({ browser }) => {
  test.setTimeout(150_000);
  const keeper = await as(browser, KEEPER);
  let page = keeper.page;
  await page.goto("/inventory/counts");
  await page.getByRole("button", { name: "Start count" }).click();
  const dialog = page.getByRole("dialog");
  await choose(page, "Warehouse", /PUN-RM/, dialog);
  await expect(page.getByLabel("Blind count")).toBeChecked();
  await pickItem(page, "Limit to items (optional)", C.bolt, dialog);
  await pickItem(page, "Limit to items (optional)", C.paint, dialog);
  await dialog.getByRole("button", { name: `Remove ${C.paint}` }).click();
  await expect(dialog.getByText(C.paint)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Start count" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/CNT\//);
  ids.count1 = page.url().split("/").pop()!;
  await expect(page.getByText("Blind", { exact: true }).filter({ visible: true })).toBeVisible();
  // The counter sees no system quantity anywhere: not on the sheet, not in the API's list or detail.
  await expect(page.getByRole("columnheader", { name: "System" })).toHaveCount(0);
  await expect(page.getByText("90", { exact: true })).toHaveCount(0);
  const listed = await api(page, "GET", `/api/v1/inventory/counts/?warehouse=${ids["PUN-RM"]}`);
  const mine = listed.results.find((c: { id: string }) => c.id === ids.count1);
  expect(mine.lines.map((l: { system_quantity: string | null }) => l.system_quantity)).toEqual([null]);
  await page.getByLabel(`Counted quantity for ${C.bolt}`).fill("88");
  await shot(page, "32-inv-count-blind-entry");
  await page.getByRole("button", { name: /Save counts/ }).click();
  await expect(page.getByText("1 of 1 lines")).toBeVisible();
  // Found stock not on the sheet: serial items are refused (counted by serial); a bracket found on a shelf is added.
  keeper.allow(/\/inventory\/counts\/[^/]+\/record\//);
  await pickItem(page, "Found stock not on the sheet", C.gauge);
  await page.getByLabel("Quantity", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(alert(page, "Serial-tracked items are counted by serial, not here.")).toBeVisible();
  await pickItem(page, "Found stock not on the sheet", C.bracket);
  await page.getByLabel("Quantity", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("2 of 2 lines")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and post" })).toHaveCount(0);
  await expect(page.getByText("Counted: waiting for approval")).toBeVisible();

  // A second, open count at Chakan that the supervisor will count themselves: system quantities are shown.
  await page.goto("/inventory/counts");
  await page.getByRole("button", { name: "Start count" }).click();
  await choose(page, "Warehouse", /CHK-RM/, dialog);
  await page.getByLabel("Blind count").click();
  await dialog.getByRole("button", { name: "Start count" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/CNT\//);
  ids.count2 = page.url().split("/").pop()!;
  const sheet = page.getByRole("table", { name: "Count sheet" });
  await expect(sheet.getByRole("columnheader", { name: "System" })).toBeVisible();
  await expect(row(sheet, C.bolt)).toContainText("10");
  await expect(row(sheet, C.paint)).toContainText("20");
  await expect(row(sheet, C.paint)).toContainText(`Batch ${C.batch}, bin ${C.binB}`);
  await expect(row(sheet, C.gauge)).toHaveCount(0); // serial items are counted by serial
  keeper.assertClean();
  await page.close();

  const sup = await as(browser, SUPERVISOR);
  page = sup.page;
  await page.goto(`/inventory/counts/${ids.count2}`);
  await page.getByLabel(`Counted quantity for ${C.bolt}`).fill("10");
  await page.getByLabel(`Counted quantity for ${C.paint}, Batch ${C.batch}, bin ${C.binB}`).fill("19.5");
  await page.getByRole("button", { name: /Save counts \(2\)/ }).click();
  await expect(page.getByText("2 of 2 lines")).toBeVisible();
  await page.getByRole("button", { name: "Approve and post" }).click();
  const refused = alert(page, "Another person must check this: you entered or prepared it.");
  await expect(refused).toBeVisible();
  await expect(refused).toContainText("maker_checker");
  await shot(page, "33-inv-count-counter-refused");

  await page.goto(`/inventory/counts/${ids.count1}`);
  const review = page.getByRole("table", { name: "Count variances" });
  await expect(row(review, C.bolt)).toContainText("90");
  await expect(row(review, C.bolt)).toContainText("−2");
  await expect(row(review, C.bracket)).toContainText("+1");
  await shot(page, "34-inv-count-review");
  await page.getByRole("button", { name: "Approve and post" }).click();
  await expect(page.getByText("Posted", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Posted variances" })).toBeVisible();

  await page.goto("/inventory/counts");
  const counts = page.getByRole("table", { name: "Stock counts" });
  await filterBy(page, "Status", "Counting");
  await expect(page).toHaveURL(/status=counting/);
  await expect(counts.getByRole("row").filter({ hasText: "CHK-RM" }).first()).toContainText("Open");
  await filterBy(page, "Status", "Posted");
  await filterBy(page, "Warehouse", /PUN-RM/);
  await expect(counts.getByRole("row").nth(1)).toContainText("Blind");
  await expect(counts.getByRole("row").filter({ hasText: "CHK-RM" })).toHaveCount(0);
  await shot(page, "34-inv-counts-list");
  sup.assertClean();
  await page.close();
});

/* ------------------------------------------------------------------ 7. Quality */

test("quality: plan with measurements; output on hold inspected, part released and part blocked; filters; NCR closed; plan edited", async ({ browser }) => {
  test.setTimeout(180_000);
  const keeper = await as(browser, KEEPER);
  const sup = await as(browser, SUPERVISOR);
  const page = sup.page;

  // The supervisor defines what inspectors measure on finished brackets.
  await page.goto("/quality?tab=plans");
  await page.getByRole("button", { name: "New plan" }).click();
  const planSheet = page.getByRole("dialog");
  await pickItem(page, "Item", C.bracket, planSheet);
  await choose(page, "Stage", "Final", planSheet);
  await planSheet.getByLabel("Sample size").fill("2");
  for (let i = 0; i < 3; i++) await planSheet.getByRole("button", { name: "Add parameter" }).click();
  await planSheet.locator("#pp-name-0").fill("Hole pitch");
  await planSheet.locator("#pp-min-0").fill("49.9");
  await planSheet.locator("#pp-max-0").fill("50.1");
  await planSheet.locator("#pp-unit-0").fill("mm");
  await planSheet.locator("#pp-name-1").fill("Weld visual");
  await planSheet.locator("#pp-kind-1").click();
  await page.getByRole("option", { name: "Pass / fail" }).click();
  await expect(planSheet.locator("#pp-min-1")).toHaveCount(0);
  await planSheet.getByRole("button", { name: "Save plan" }).click();
  await expect(alert(planSheet, "Every parameter needs a name.")).toBeVisible();
  await planSheet.getByRole("button", { name: "Remove parameter 3" }).click();
  await shot(page, "36-quality-plan-new");
  await planSheet.getByRole("button", { name: "Save plan" }).click();
  await expect(planSheet).toHaveCount(0);
  const plans = page.getByRole("table", { name: "Inspection plans" });
  await expect(row(plans, C.bracket)).toContainText("Hole pitch, Weld visual");

  // Put finished goods on quality hold through production (manufacturing screens belong to another team).
  const bom = await api(keeper.page, "POST", "/api/v1/manufacturing/boms/", { item: ids[C.bracket], code: `BOM-${RUN}`, name: `Bracket ${RUN}` });
  const withVersion = await api(keeper.page, "POST", `/api/v1/manufacturing/boms/${bom.id}/versions/`, {
    output_quantity: "1", effective_from: today(), components: [{ item: ids[C.bolt], quantity: "2", issue_method: "backflush" }],
  });
  await api(page, "POST", `/api/v1/manufacturing/boms/${bom.id}/versions/${withVersion.versions.at(-1).id}/approve/`, {});
  const mo = await api(keeper.page, "POST", "/api/v1/manufacturing/orders/", {
    company: ids.company, facility: ids["PUN-P1"], item: ids[C.bracket], quantity: "5", planned_start: today(), planned_end: today(),
    source_warehouse: ids["PUN-RM"], wip_warehouse: ids["PUN-WIP"], output_warehouse: ids["PUN-FG"],
  });
  await api(keeper.page, "POST", `/api/v1/manufacturing/orders/${mo.id}/release/`, {});
  await api(keeper.page, "POST", `/api/v1/manufacturing/orders/${mo.id}/output/`, { on: today(), quantity: "4" });

  // Release reserved 10 bolts; 4 brackets consumed 8, so 2 stay reserved.
  await keeper.page.goto(`/inventory/stock?warehouse=${ids["PUN-RM"]}&item=${ids[C.bolt]}`);
  await row(keeper.page, C.bolt).getByRole("button").click();
  const sheet = keeper.page.getByRole("dialog");
  await expect(sheet.getByLabel("Availability")).toContainText(`78 ${C.pcs}`);
  await expect(sheet.getByLabel("Availability")).toContainText(`80 ${C.pcs}`);
  await expect(fact(sheet, "Reserved")).toHaveText(`2 ${C.pcs}`);
  await shot(keeper.page, "35-inv-availability-reserved");
  keeper.assertClean();
  await keeper.page.close();

  await page.goto("/quality");
  const inspections = page.getByRole("table", { name: "Inspections" });
  const pending = row(inspections, C.bracket);
  await expect(pending).toContainText("Waiting for decision");
  await shot(page, "36-quality-pending");
  await pending.getByRole("button", { name: "Decide" }).click();
  const decide = page.getByRole("dialog");
  await expect(decide.getByText("Quantity on hold")).toBeVisible();
  await expect(fact(decide, "Plan")).toHaveText("2 parameters, sample 2");
  await decide.getByLabel(/Hole pitch/).fill("50.3");
  await choose(page, /Weld visual/, "Fail", decide);
  await decide.getByLabel("Accepted").fill("3");
  await expect(decide.getByLabel("Rejected")).toHaveValue("1");
  await decide.getByRole("button", { name: "Record decision" }).click();
  await expect(alert(decide, "Say why material was rejected")).toBeVisible();
  await decide.getByLabel("Remarks").fill("Weld porosity on one bracket");
  await shot(page, "37-quality-decide");
  await decide.getByRole("button", { name: "Record decision" }).click();
  await expect(decide.getByText("Partly accepted")).toBeVisible();
  await expect(decide.getByRole("listitem").filter({ hasText: "Hole pitch" })).toContainText("Out of tolerance");
  await expect(decide.getByRole("listitem").filter({ hasText: "Weld visual" })).toContainText("Out of tolerance");
  await shot(page, "37-quality-decided");
  await page.keyboard.press("Escape");

  // Filters: decided inspections leave the default (waiting) view.
  await expect(row(inspections, C.bracket)).toHaveCount(0);
  await filterBy(page, "Status", "Partly accepted");
  await filterBy(page, "Stage", "Final");
  await filterBy(page, "Warehouse", /PUN-FG/);
  await expect(row(inspections, C.bracket)).toContainText("Partly accepted");
  await filterBy(page, "Stage", "Receipt");
  await expect(row(inspections, C.bracket)).toHaveCount(0);
  await filterBy(page, "Stage", "Any stage");
  await filterBy(page, "Status", "Accepted");
  await expect(row(inspections, C.bracket)).toHaveCount(0);
  await filterBy(page, "Status", "All");
  await expect(row(inspections, C.bracket)).toBeVisible();

  // Stock moved out of quality hold: 3 unrestricted, 1 blocked.
  await page.goto(`/inventory/stock?warehouse=${ids["PUN-FG"]}`);
  await row(page, C.bracket).getByRole("button").click();
  const avail = page.getByRole("dialog");
  await expect(avail.getByLabel("Availability")).toContainText(`3 ${C.pcs}`);
  await expect(fact(avail, "Blocked")).toHaveText(`1 ${C.pcs}`);
  await expect(fact(avail, "Quality hold")).toHaveText(`0 ${C.pcs}`);
  await page.keyboard.press("Escape");

  await page.goto("/quality?tab=ncrs");
  const ncr = row(page, /Weld porosity/);
  await expect(ncr).toContainText("Open");
  // The NCR links back to its inspection.
  await ncr.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("dialog").getByText("Partly accepted")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await ncr.getByRole("button", { name: "Close" }).click();
  const closeDialog = page.getByRole("dialog");
  await expect(closeDialog.getByRole("button", { name: "Close NCR" })).toBeDisabled();
  await choose(page, "Disposition", "Rework", closeDialog);
  await closeDialog.getByLabel("Corrective action").fill("Re-weld and re-inspect; weld parameters reset on cell 2.");
  await closeDialog.getByRole("button", { name: "Close NCR" }).click();
  await expect(page.getByText("No open non-conformances")).toBeVisible();
  await filterBy(page, "NCR status", "Closed");
  await expect(row(page, /Weld porosity/)).toContainText("Rework");
  await filterBy(page, "NCR status", "All");
  await expect(row(page, /Weld porosity/)).toContainText("Closed");
  await shot(page, "38-quality-ncrs");

  // Edit the plan: larger sample, then retire it.
  await page.goto("/quality?tab=plans");
  await row(plans, C.bracket).getByRole("button", { name: "Edit plan" }).click();
  await expect(planSheet.getByLabel("Stage")).toBeDisabled();
  await planSheet.getByLabel("Sample size").fill("5");
  await planSheet.getByLabel("Active").uncheck();
  await planSheet.getByRole("button", { name: "Save plan" }).click();
  await expect(planSheet).toHaveCount(0);
  await expect(row(plans, C.bracket)).toContainText("Inactive");
  await expect(row(plans, C.bracket)).toContainText("5");
  await shot(page, "39-quality-plans");
  sup.assertClean();
  await page.close();
});

/* ------------------------------------------------------------------ 8. Ledger and item locks */

test("ledger: cursor pages, filters and source links; stock unit locks after movements; edits detect conflicts", async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, assertClean, allow } = await as(browser, KEEPER);
  await page.goto(`/inventory/ledger?size=10`);
  const table = page.getByRole("table", { name: "Stock ledger entries" });
  await expect(page.getByRole("button", { name: "Newer entries" })).toBeDisabled();
  await expect(table.getByRole("row")).toHaveCount(11); // header + 10
  await page.getByRole("button", { name: "Older entries" }).click();
  await expect(page).toHaveURL(/cursor=/);
  await expect(page.getByRole("button", { name: "Newer entries" })).toBeEnabled();
  await page.getByRole("button", { name: "Newer entries" }).click();
  await expect(table.getByRole("row")).toHaveCount(11);
  await filterBy(page, "Rows per page", "25");
  await expect(page).toHaveURL(/size=25/);
  await expect.poll(() => table.getByRole("row").count()).toBeGreaterThan(11); // more than one page of 10

  // Filters: item, warehouse, movement, dates; Clear resets them.
  await pickItem(page, "Item", C.bolt);
  await expect(page).toHaveURL(new RegExp(`item=${ids[C.bolt]}`));
  await filterBy(page, "Movement", "Transfer out");
  await expect(row(table, /Transfer out/)).toContainText("−10");
  await expect(row(table, /Adjustment in/)).toHaveCount(0);
  await filterBy(page, "Movement", "Any movement");
  await filterBy(page, "Warehouse", /CHK-RM/);
  await expect(row(table, /Transfer in/)).toContainText("+10");
  await expect(row(table, /Adjustment in/)).toHaveCount(0);
  await page.getByLabel("From date").fill(today());
  await expect(page).toHaveURL(new RegExp(`from=${today()}`));
  await page.getByLabel("To date").fill(today());
  await expect(page).toHaveURL(new RegExp(`to=${today()}`));
  await expect(row(table, /Transfer in/)).toBeVisible();
  // The source column opens the document.
  await row(table, /Transfer in/).getByRole("link", { name: "Transfer" }).click();
  await expect(page).toHaveURL(new RegExp(`/inventory/transfers/${ids.trf}`));
  await page.goBack();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page).not.toHaveURL(/item=|warehouse=|from=/);
  await page.goto(`/inventory/ledger?item=${ids[C.bolt]}&movement=count_loss`);
  await expect(row(table, /Count loss/)).toContainText("−2");
  await shot(page, "40-inv-ledger");

  await page.goto(`/masterdata/items/${ids[C.bolt]}`);
  await expect(page.getByText("Has stock history", { exact: true })).toBeVisible();
  await expect(page.getByText("Fixed: the item has stock history")).toHaveCount(2);
  await expect(page.getByLabel("Stock unit")).toBeDisabled();
  await expect(page.getByLabel("Tracking")).toBeDisabled();
  // The API enforces the lock too.
  const before = await api(page, "GET", `/api/v1/masterdata/items/${ids[C.bolt]}/`);
  const kgId = (await api(page, "GET", "/api/v1/masterdata/uoms/")).find((u: { code: string }) => u.code === C.kg).id;
  const locked = await call(page, "PATCH", `/api/v1/masterdata/items/${ids[C.bolt]}/`, { stock_uom: kgId, version: before.version });
  expect(locked.status).toBeGreaterThanOrEqual(400);
  expect(locked.json.code).toBe("item_locked_by_stock");
  await page.getByLabel("Name", { exact: true }).fill(`Hex bolt M10 x 40 ${RUN}`);
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByText("Item saved")).toBeVisible();

  // Someone else saves first: the page reports the conflict instead of overwriting.
  allow(/\/masterdata\/items\//);
  const item = await api(page, "GET", `/api/v1/masterdata/items/${ids[C.bolt]}/`);
  await api(page, "PATCH", `/api/v1/masterdata/items/${ids[C.bolt]}/`, { description: "Zinc plated", version: item.version });
  await page.getByLabel("Name", { exact: true }).fill(`Hex bolt M10 x 45 ${RUN}`);
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(alert(page, "Someone changed this")).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue("Zinc plated");
  assertClean();
  await page.close();
});

/* ------------------------------------------------------------------ 9. Phones */

test("every inventory, master data and quality screen fits a 375 px phone", async ({ browser }) => {
  test.setTimeout(180_000);
  const phone = { width: 375, height: 812 };
  const { page, assertClean } = await as(browser, SUPERVISOR, phone);
  const routes: Array<[string, string, string]> = [
    ["/inventory/stock", "Stock on hand", "50-m-stock"],
    ["/inventory/stock?tab=ageing", "Stock on hand", "51-m-ageing"],
    ["/inventory/ledger", "Stock ledger", "52-m-ledger"],
    ["/inventory/adjustments", "Stock adjustments", "53-m-adjustments"],
    [`/inventory/adjustments/${ids.adj}`, "ADJ", "54-m-adjustment"],
    [`/inventory/adjustments/${ids.adjBig}`, "Unposted adjustment", "54-m-adjustment-submitted"],
    ["/inventory/adjustments/new", "New stock adjustment", "55-m-adjustment-new"],
    ["/inventory/transfers", "Stock transfers", "56-m-transfers"],
    [`/inventory/transfers/${ids.trf}`, "TRF", "56-m-transfer"],
    ["/inventory/counts", "Stock counts", "57-m-counts"],
    [`/inventory/counts/${ids.count1}`, "CNT", "58-m-count"],
    [`/inventory/counts/${ids.count2}`, "CNT", "58-m-count-open"],
    ["/masterdata/items", "Items", "59-m-items"],
    [`/masterdata/items/${ids[C.bolt]}`, C.bolt, "60-m-item"],
    ["/masterdata/setup", "Item setup", "61-m-setup"],
    ["/masterdata/setup?tab=conversions", "Item setup", "61-m-setup-conversions"],
    ["/masterdata/setup?tab=categories", "Item setup", "61-m-setup-categories"],
    ["/masterdata/setup?tab=hsn", "Item setup", "61-m-setup-hsn"],
    ["/quality?status=all", "Quality", "62-m-quality"],
    ["/quality?tab=ncrs&ncr=all", "Quality", "62-m-quality-ncrs"],
    ["/quality?tab=plans", "Quality", "62-m-quality-plans"],
  ];
  for (const [path, heading, name] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await shot(page, name);
  }
  await page.goto("/inventory/stock");
  await row(page, C.bolt).first().getByRole("button").click();
  await expect(page.getByRole("dialog").getByText("Available to issue")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, "63-m-availability");
  await page.goto("/quality?status=all");
  await row(page, C.bracket).getByRole("button", { name: /Open inspection/ }).click();
  await expect(page.getByRole("dialog").getByText("Partly accepted")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, "64-m-inspection");
  assertClean();
  await page.close();

  // Forms only the store keeper opens
  const keeper = await as(browser, KEEPER, phone);
  const k = keeper.page;
  await k.goto("/masterdata/items");
  await k.getByRole("button", { name: "New item" }).click();
  await expect(k.getByRole("dialog").getByLabel("Item code")).toBeVisible();
  await expectNoHorizontalScroll(k);
  await shot(k, "65-m-item-new");
  await k.goto("/inventory/counts");
  await k.getByRole("button", { name: "Start count" }).click();
  await expect(k.getByRole("dialog").getByLabel("Blind count")).toBeVisible();
  await expectNoHorizontalScroll(k);
  await shot(k, "66-m-count-start");
  await k.goto("/inventory/transfers/new");
  await expect(k.getByRole("heading", { level: 1 })).toContainText("New stock transfer");
  await expectNoHorizontalScroll(k);
  await shot(k, "67-m-transfer-new");
  await k.goto(`/inventory/adjustments/${ids.adjCancelled}`);
  await expect(k.getByText("This adjustment was withdrawn before posting.")).toBeVisible();
  await expectNoHorizontalScroll(k);
  await shot(k, "68-m-adjustment-cancelled");
  keeper.assertClean();
  await k.close();
});
