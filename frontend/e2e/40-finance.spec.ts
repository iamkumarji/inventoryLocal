import { readFileSync } from "node:fs";

import { type Browser, type BrowserContext, expect as baseExpect, type Locator, type Page, test } from "@playwright/test";

import { currentStep, expectNoHorizontalScroll, loadAdmin, saveAdmin, shot, totp, watchConsole } from "./helpers";

/*
 * Finance and analytics screens against the real API. Setup data (modules, roles, people, partners, a
 * purchase order with a backdated goods receipt, a sales order delivered over four months and invoiced,
 * a prior fiscal year) is created through the API by the people allowed to create it; the behaviour
 * under test is driven through the UI.
 *
 * People: Arun prepares (maker), Kavya checks, approves and posts (checker), Vikram may only open
 * dashboards, and Neha runs stores and sales (operations) so procurement and sales documents exist.
 *
 * MFA step-up: payments, journal posting, posting rules and period close need a fresh verification.
 * Run the backend with a short window (ERP_STEP_UP_MINUTES=1) and tell the spec (E2E_STEP_UP_MINUTES=1)
 * so the step-up prompt is exercised deterministically; with the default 15 minutes that check is skipped.
 */

test.describe.configure({ mode: "serial" });
// The dev server compiles each route on first visit; give navigations after an action time to land.
const expect = baseExpect.configure({ timeout: 15_000 });

const STAMP = Date.now().toString(36).slice(-5).toUpperCase();
const NEW_PASSWORD = "Ledger-Checker-Passphrase-2026";
const TEMP = "Temp-Finance-Passw0rd-2026";
const STEP_UP_MS = Number(process.env.E2E_STEP_UP_MINUTES ?? 15) * 60_000;

/** Local calendar date `months` months back (0 = this month) on `day`, as YYYY-MM-DD. */
function monthsAgo(months: number, day: number) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - months, day).toLocaleDateString("en-CA");
}
const today = new Date().toLocaleDateString("en-CA");
const fyStartYear = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1; // April–March
const lastMonthInvoiceDate = monthsAgo(1, 20);
// An 8-digit HSN code of this run's own, so GSTR-1's HSN summary row holds only this run's sales.
const HSN = `7307${String(Date.now() % 10_000).padStart(4, "0")}`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Session = { context: BrowserContext; page: Page; csrf: string; email: string; secret?: string; lastStep: number; verifiedAt: number };
const state: {
  orgId?: string; companyId?: string; checkerRoleId?: string;
  maker?: Session; checker?: Session; viewer?: Session; ops?: Session;
  supplierId?: string; supplierName?: string; customerId?: string; customerName?: string; bankId?: string; bankLedgerId?: string;
  vendorId?: string; vendorName?: string; grnNumber?: string; item?: { id: string; code: string };
  salesInvoice?: string; priorYearId?: string; currentYearCode?: string;
  accounts?: Record<string, string>; journalUrl?: string; invoiceAUrl?: string; invoiceCUrl?: string; paymentUrl?: string;
} = {};

const MODULES = ["finance", "analytics", "partners", "masterdata", "inventory", "procurement", "sales"];

function baseURL() {
  return (test.info().project.use.baseURL as string | undefined) ?? "http://localhost:3000";
}

async function csrfOf(context: BrowserContext) {
  return (await context.cookies()).find((c) => c.name === "erp_csrf")?.value ?? "";
}

/** Waits for a TOTP time step this person hasn't used yet (the server rejects replayed codes). */
async function freshCode(s: Session) {
  while (currentStep() <= s.lastStep) await new Promise((r) => setTimeout(r, 1000));
  s.lastStep = currentStep();
  return totp(s.secret!);
}

/** API call as this person. A step-up request (403 mfa_required) is answered with a fresh code, once. */
async function call<T = Record<string, unknown>>(s: Session, method: string, path: string, data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await s.context.request.fetch(`/api/v1${path}`, {
      method, data, headers: { "X-CSRF-Token": s.csrf || (await csrfOf(s.context)), ...headers },
    });
    const text = await res.text();
    s.csrf = await csrfOf(s.context);
    if (res.status() === 403 && attempt === 0 && s.secret && text.includes('"mfa_required"')) {
      await call(s, "POST", "/auth/step-up/", { code: await freshCode(s) });
      s.verifiedAt = Date.now();
      if (headers["Idempotency-Key"]) headers = { ...headers, "Idempotency-Key": crypto.randomUUID() };
      continue;
    }
    if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }
}

const idem = () => ({ "Idempotency-Key": crypto.randomUUID() });
const rows = <T>(r: T[] | { results: T[] }) => (Array.isArray(r) ? r : r.results);

async function newSession(browser: Browser, email: string): Promise<Session> {
  const context = await browser.newContext({ baseURL: baseURL(), viewport: { width: 1440, height: 900 } });
  return { context, page: await context.newPage(), csrf: "", email, lastStep: 0, verifiedAt: 0 };
}

/** First sign-in of a new person through the API: enrol TOTP when required, replace the temporary password. */
async function onboard(browser: Browser, email: string, mfa: boolean): Promise<Session> {
  const s = await newSession(browser, email);
  const login = await call<{ status: string }>(s, "POST", "/auth/login/", { email, password: TEMP, client_type: "web" });
  if (mfa) {
    expect(login.status).toBe("mfa_enrollment_required");
    const setup = await call<{ secret: string }>(s, "POST", "/auth/mfa/totp/setup/");
    s.secret = setup.secret;
    await call(s, "POST", "/auth/mfa/totp/confirm/", { code: await freshCode(s) });
    s.verifiedAt = Date.now();
  }
  await call(s, "POST", "/auth/password/change/", { current_password: TEMP, new_password: NEW_PASSWORD });
  return s;
}

const stepUpDialog = (page: Page) => page.getByRole("dialog").filter({ hasText: "Confirm it's you" });

/**
 * After an action that needs a recent MFA check: if the verification is (nearly) older than the server's
 * step-up window, the "Confirm it's you" prompt appears; answer it with a fresh code.
 */
async function stepUp(s: Session) {
  if (Date.now() - s.verifiedAt < STEP_UP_MS - 10_000) return;
  const dialog = stepUpDialog(s.page);
  if (!(await dialog.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false))) return;
  await dialog.getByLabel("Verification code").fill(await freshCode(s));
  await dialog.getByRole("button", { name: "Verify and continue" }).click();
  await expect(dialog).toHaveCount(0);
  s.verifiedAt = Date.now();
}

/** Console watcher for steps where the API is expected to refuse (the refusal is what the UI shows). */
function watchConsoleAllowingRefusals(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/status of (400|401|403|409|422)|WebSocket connection/.test(m.text())) return;
    errors.push(m.text());
  });
  return () => expect(errors, errors.join("\n")).toEqual([]);
}

/** Captures the page at 375 px after checking it doesn't scroll sideways, then restores the desktop width. */
async function mobile(page: Page, name: string) {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(250);
  await expectNoHorizontalScroll(page);
  await shot(page, `${name}-375`);
  await page.setViewportSize({ width: 1440, height: 900 });
}

const statementRow = (page: Page, name: RegExp) => page.getByRole("table", { name: "Bank statement lines" }).getByRole("row", { name });

/** Chooses a ledger account in an AccountPicker by code. */
async function pickAccountIn(page: Page, trigger: Locator, code: string) {
  await trigger.click();
  await page.getByPlaceholder("Code or name").fill(code);
  await page.getByRole("option", { name: new RegExp(`^${code}\\b`) }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toContainText(code);
  await expect(page.locator("[data-slot=popover-content]")).toHaveCount(0); // closing animation finished
}
const pickAccount = (page: Page, triggerId: string, code: string) => pickAccountIn(page, page.locator(`#${triggerId}`), code);

/** Chooses a partner in a PartnerPicker by code. */
async function pickPartner(page: Page, trigger: Locator, code: string, name: string) {
  await trigger.click();
  await page.getByPlaceholder("Name or code").fill(code);
  await page.getByRole("option", { name: new RegExp(esc(name)) }).click();
}

/** Chooses an option in a Radix select. */
async function pickSelect(page: Page, trigger: Locator, option: string | RegExp) {
  await trigger.click();
  await page.getByRole("option", { name: option }).first().click();
}

test("setup: modules, roles, people, partners, procurement and sales history, a prior fiscal year", async ({ browser }) => {
  test.setTimeout(240_000);
  const admin = loadAdmin();
  const a = await newSession(browser, "admin@demo.local");
  const login = await call<{ status: string; challenge_token: string }>(a, "POST", "/auth/login/", { email: "admin@demo.local", password: admin.password, client_type: "web" });
  expect(login.status).toBe("mfa_required");
  while (currentStep() <= admin.lastStep) await new Promise((r) => setTimeout(r, 1000));
  const step = currentStep();
  await call(a, "POST", "/auth/login/mfa/", { challenge_token: login.challenge_token, code: totp(admin.secret) });
  saveAdmin({ ...admin, lastStep: step });

  const me = await call<{ user: { organization_id: string }; active_company_id: string }>(a, "GET", "/auth/me/");
  state.orgId = me.user.organization_id;
  state.companyId = me.active_company_id;

  // Business modules start switched off; the administrator turns them on for this organization.
  const flags = await call<{ id: string; key: string; enabled_default: boolean }[]>(a, "GET", "/admin/feature-flags/");
  for (const key of MODULES.map((m) => `module.${m}`)) {
    const flag = flags.find((f) => f.key === key);
    expect(flag, key).toBeTruthy();
    if (!flag!.enabled_default) {
      const updated = await call<{ enabled_default: boolean }>(a, "PATCH", `/admin/feature-flags/${flag!.id}/`, { enabled_default: true });
      expect(updated.enabled_default, key).toBe(true);
    }
  }

  const perms = (await call<{ code: string }[]>(a, "GET", "/authorization/permissions/")).map((p) => p.code);
  const finance = perms.filter((c) => c.startsWith("finance."));
  const makerCodes = [
    ...finance.filter((c) => !/\.(approve|reject|self_approve)$/.test(c)),
    "finance.budget.approve", // may approve budgets, but never one they prepared (maker-checker)
    ...perms.filter((c) => c.startsWith("analytics.")),
    "partners.partner.create", "partners.partner.read", "partners.supplier.read", "partners.customer.read",
    "partners.bank_account.read", "partners.bank_account.update",
    "organization.fiscal_year.read", "procurement.purchase_order.read", "procurement.goods_receipt.read", "masterdata.item.read",
    "inventory.stock_ledger.read", // the demand forecast reads stock history of warehouses the user may see
  ];
  const checkerCodes = [
    ...finance.filter((c) => !c.endsWith(".self_approve")),
    ...perms.filter((c) => c.startsWith("analytics.")), "authorization.approval_limit.read", "authorization.approval_limit.manage",
    "partners.partner.read", "partners.supplier.read", "partners.customer.read", "partners.supplier.approve",
    "partners.bank_account.read", "partners.bank_account.approve",
    "organization.company.read", "organization.fiscal_year.read", "organization.fiscal_year.create", "procurement.purchase_order.read", "procurement.purchase_order.approve",
    "masterdata.item.read", "inventory.stock_ledger.read",
  ];
  const opsCodes = perms.filter((c) => (/^(masterdata|inventory|organization)\./.test(c) && /\.(read|create|update)$/.test(c) && !c.startsWith("organization.fiscal_year"))
    || (/^procurement\./.test(c) && /\.(read|create|update|post)$/.test(c))
    || (/^sales\./.test(c) && /\.(read|create|update|post)$/.test(c))
    || ["partners.partner.create", "partners.partner.read", "partners.partner.update", "partners.customer.read", "partners.customer.update",
      "partners.supplier.read", "partners.supplier.update"].includes(c));
  const role = (code: string, name: string, permission_codes: string[], mfa_required: boolean) =>
    call<{ id: string }>(a, "POST", "/authorization/roles/", { code: `${code}_${STAMP.toLowerCase()}`, name: `${name} ${STAMP}`, description: "E2E finance spec", permission_codes, mfa_required });
  const makerRole = await role("e2e_fin_maker", "E2E accountant", makerCodes, true);
  const checkerRole = await role("e2e_fin_checker", "E2E finance controller", checkerCodes, true);
  const viewerRole = await role("e2e_dash_viewer", "E2E dashboard viewer", ["analytics.dashboard.read"], false);
  const opsRole = await role("e2e_fin_ops", "E2E stores and sales", opsCodes, false);
  state.checkerRoleId = checkerRole.id;

  const people = [
    { key: "maker", email: `arun.${STAMP.toLowerCase()}@demo.local`, name: `Arun Mehta (E2E ${STAMP})`, role: makerRole.id, mfa: true },
    { key: "checker", email: `kavya.${STAMP.toLowerCase()}@demo.local`, name: `Kavya Rao (E2E ${STAMP})`, role: checkerRole.id, mfa: true },
    { key: "viewer", email: `vikram.${STAMP.toLowerCase()}@demo.local`, name: `Vikram Shah (E2E ${STAMP})`, role: viewerRole.id, mfa: false },
    { key: "ops", email: `neha.${STAMP.toLowerCase()}@demo.local`, name: `Neha Kulkarni (E2E ${STAMP})`, role: opsRole.id, mfa: false },
  ] as const;
  for (const p of people) {
    const user = await call<{ id: string }>(a, "POST", "/identity/users/", {
      email: p.email, full_name: p.name, phone: "", default_company: state.companyId, mfa_enforced: p.mfa, temporary_password: TEMP,
    }, idem());
    await call(a, "POST", "/authorization/role-assignments/", {
      user: user.id, role: p.role, scope_type: "organization", scope_id: state.orgId, include_descendants: true, reason: "E2E finance spec",
    }, idem());
  }
  await a.context.close();

  state.maker = await onboard(browser, people[0].email, true);
  state.checker = await onboard(browser, people[1].email, true);
  state.viewer = await onboard(browser, people[2].email, false);
  state.ops = await onboard(browser, people[3].email, false);
  const [m, c, ops] = [state.maker, state.checker, state.ops];

  // The finance controller sets approval limits for their own role (a control the system admin can't touch).
  // The supplier-invoice limit starts low on purpose; the invoice test raises it after a refusal.
  for (const [document_type, max_amount] of [["finance.payment", "1000000.00"], ["procurement.purchase_order", "1000000.00"], ["finance.supplier_invoice", "10000.00"]]) {
    await call(c, "POST", "/authorization/approval-limits/", { role: state.checkerRoleId, document_type, currency: "INR", max_amount });
  }

  const accounts = await call<{ id: string; code: string }[]>(m, "GET", "/finance/accounts/");
  state.accounts = Object.fromEntries(accounts.map((x) => [x.code, x.id]));
  state.supplierName = `Kaveri Castings (E2E ${STAMP})`;
  state.supplierId = (await call<{ id: string }>(m, "POST", "/partners/", { code: `SUP-${STAMP}`, name: state.supplierName, is_supplier: true, gst_registration: "unregistered", state_code: "27" })).id;
  // A registered customer in another state: its sales are B2B and inter-state (IGST) in GSTR-1.
  state.customerName = `Sahyadri Motors (E2E ${STAMP})`;
  state.customerId = (await call<{ id: string }>(m, "POST", "/partners/", {
    code: `CUS-${STAMP}`, name: state.customerName, is_customer: true, gst_registration: "regular", gstin: "29AABCK5678D1Z9", state_code: "29",
  })).id;
  // Each run gets its own bank ledger account, so reconciliation figures belong to this run only.
  state.bankLedgerId = (await call<{ id: string }>(m, "POST", "/finance/accounts/", {
    company: state.companyId, code: `11${STAMP}`, name: `HDFC current account (E2E ${STAMP})`, account_type: "asset", sub_type: "bank",
    parent: state.accounts["1000"], is_group: false, is_control: false, is_active: true,
  })).id;
  state.bankId = (await call<{ id: string }>(m, "POST", "/finance/bank-accounts/", {
    company: state.companyId, account: state.bankLedgerId, bank_name: `HDFC Bank, Pune (E2E ${STAMP})`, ifsc: "HDFC0001234", account_last4: "4321",
  })).id;

  // A customer receipt into the bank, prepared and posted by the accountant (receipts need no approval).
  const receipt = await call<{ id: string; version: number }>(m, "POST", "/finance/payments/", {
    company: state.companyId, kind: "customer_receipt", partner: state.customerId, bank_account: state.bankId, payment_date: today,
    mode: "neft", reference: `UTR${STAMP}5000`, amount: "5000.00", allocations: [],
  });
  const submitted = await call<{ version: number; status: string }>(m, "POST", `/finance/payments/${receipt.id}/submit/`, { version: receipt.version });
  expect(submitted.status).toBe("approved");
  const posted = await call<{ status: string }>(m, "POST", `/finance/payments/${receipt.id}/post/`, { version: submitted.version }, idem());
  expect(posted.status).toBe("posted");

  // A vendor for the purchase-to-pay flow: created by operations, approved by the controller; its bank
  // account is entered by the accountant and verified by the controller (two different people).
  state.vendorName = `Deccan Forgings (E2E ${STAMP})`;
  state.vendorId = (await call<{ id: string }>(ops, "POST", "/partners/", {
    code: `VEN-${STAMP}`, name: state.vendorName, is_supplier: true, gst_registration: "regular", gstin: "27AAACB1234C1Z5", state_code: "27",
  })).id;
  await call(c, "POST", `/partners/${state.vendorId}/approve-supplier/`, { approve: true, note: "Vendor onboarding checked" });
  const vendorBank = await call<{ id: string; status: string }>(m, "POST", `/partners/${state.vendorId}/bank-accounts/`, {
    bank_name: "State Bank of India", ifsc: "SBIN0001234", account_holder: "Deccan Forgings Pvt Ltd", account_number: "30012345678901",
  });
  const verified = await call<{ status: string }>(c, "POST", `/partners/${state.vendorId}/bank-accounts/${vendorBank.id}/review/`, { approve: true, note: "Matched against cancelled cheque" });
  expect(verified.status).toBe("verified");
  await call(ops, "PATCH", `/partners/${state.customerId}/customer-terms/`, { credit_limit: "500000.00" });

  // Item master (operations): a stocked, bought and sold flange at 18% GST.
  const uoms = rows(await call<{ id: string; code: string }[] | { results: { id: string; code: string }[] }>(ops, "GET", "/masterdata/uoms/?page_size=200"));
  const nos = uoms.find((u) => u.code === "NOS")?.id ?? (await call<{ id: string }>(ops, "POST", "/masterdata/uoms/", { code: "NOS", name: "Numbers", kind: "count", decimals: 0 })).id;
  const hsn = (await call<{ id: string }>(ops, "POST", "/masterdata/hsn-codes/", { code: HSN, description: "Tube or pipe fittings (flanges)", gst_rate: "18" })).id;
  const category = await call<{ id: string }>(ops, "POST", "/masterdata/item-categories/", { code: `F${STAMP}`, name: `Forged parts ${STAMP}`, posting_group: "TRD" });
  const itemCode = `FLG-${STAMP}`;
  const item = await call<{ id: string }>(ops, "POST", "/masterdata/items/", {
    code: itemCode, name: `Flange coupling FC-50 (E2E ${STAMP})`, item_type: "component", category: category.id, stock_uom: nos, purchase_uom: nos,
    sales_uom: nos, hsn, is_stocked: true, is_purchasable: true, is_saleable: true, standard_cost: "250",
  });
  state.item = { id: item.id, code: itemCode };

  const branch = rows(await call<{ id: string; code: string }[] | { results: { id: string; code: string }[] }>(ops, "GET", "/organization/branches/?page_size=100")).find((b) => b.code === "PUN")!;
  const store = rows(await call<{ id: string; code: string }[] | { results: { id: string; code: string }[] }>(ops, "GET", "/organization/warehouses/?page_size=100")).find((w) => w.code === "PUN-RM")!;
  expect(branch && store, "seed_demo branch PUN and warehouse PUN-RM").toBeTruthy();

  // Purchase order five months ago (approved by the controller), received in full mid-month.
  let po = await call<{ id: string; version: number; status: string; lines: { id: string }[] }>(ops, "POST", "/procurement/orders/", {
    company: state.companyId, branch: branch.id, supplier: state.vendorId, order_date: monthsAgo(5, 1), expected_date: monthsAgo(5, 10),
    lines: [{ item: item.id, quantity: "100", uom: nos, rate: "250", warehouse: store.id }],
  });
  po = await call(ops, "POST", `/procurement/orders/${po.id}/submit/`, { version: po.version });
  if (po.status === "submitted") po = await call(c, "POST", `/procurement/orders/${po.id}/decide/`, { approve: true, comment: "Agreed rate", version: po.version });
  expect(po.status).toBe("approved");
  let grn = await call<{ id: string; version: number; number: string; status: string }>(ops, "POST", "/procurement/receipts/", {
    purchase_order: po.id, warehouse: store.id, receipt_date: monthsAgo(5, 15), supplier_delivery_note: `DC-${STAMP}`,
    lines: [{ po_line: po.lines[0].id, quantity: "100" }],
  }, idem());
  grn = await call(ops, "POST", `/procurement/receipts/${grn.id}/post/`, { version: grn.version }, idem());
  expect(grn.status).toBe("posted");
  state.grnNumber = grn.number;

  // One sales order delivered over the last four months (the demand history the forecast reads),
  // invoiced last month.
  let so = await call<{ id: string; version: number; status: string; lines: { id: string }[] }>(ops, "POST", "/sales/orders/", {
    company: state.companyId, branch: branch.id, customer: state.customerId, order_date: monthsAgo(4, 1), requested_date: monthsAgo(4, 5),
    customer_po: `PO-SM-${STAMP}`, place_of_supply: "29", lines: [{ item: item.id, quantity: "48", uom: nos, rate: "1200", warehouse: store.id }],
  });
  so = await call(ops, "POST", `/sales/orders/${so.id}/submit/`, { version: so.version });
  expect(so.status).toBe("approved");
  for (const [months, quantity] of [[4, "10"], [3, "14"], [2, "12"], [1, "12"]] as const) {
    const d = await call<{ id: string; version: number }>(ops, "POST", "/sales/deliveries/", {
      sales_order: so.id, warehouse: store.id, delivery_date: monthsAgo(months, 10), lines: [{ so_line: so.lines[0].id, quantity }],
    });
    await call(ops, "POST", `/sales/deliveries/${d.id}/post/`, { version: d.version }, idem());
  }
  const si = await call<{ id: string; version: number }>(ops, "POST", "/sales/invoices/", { sales_order: so.id, invoice_date: monthsAgo(1, 25) });
  const siPosted = await call<{ number: string; status: string }>(ops, "POST", `/sales/invoices/${si.id}/post/`, { version: si.version }, idem());
  expect(siPosted.status).toBe("posted");
  state.salesInvoice = siPosted.number;

  // The previous fiscal year, with one expense posted in its last month, for the year-end close.
  const years = rows(await call<{ id: string; code: string; start_date: string }[] | { results: { id: string; code: string; start_date: string }[] }>(c, "GET", "/organization/fiscal-years/?page_size=50"));
  state.currentYearCode = years.find((y) => y.start_date === `${fyStartYear}-04-01`)!.code;
  state.priorYearId = years.find((y) => y.start_date === `${fyStartYear - 1}-04-01`)?.id
    ?? (await call<{ id: string }>(c, "POST", "/organization/fiscal-years/", { company: state.companyId, start_year: fyStartYear - 1 })).id;
  const je = await call<{ id: string; version: number }>(m, "POST", "/finance/journal-entries/", {
    company: state.companyId, entry_date: `${fyStartYear}-03-15`, narration: `Compressor service, last year (E2E ${STAMP})`,
    lines: [
      { account: state.accounts["5420"], debit: "2000.00", credit: "0", description: "" },
      { account: state.accounts["1100"], debit: "0", credit: "2000.00", description: "" },
    ],
  });
  await call(c, "POST", `/finance/journal-entries/${je.id}/post/`, { version: je.version }, idem());
});

test("manual journal: maker drafts, checker posts and reverses; trial balance stays balanced", async () => {
  test.setTimeout(150_000);
  const maker = state.maker!.page;
  const assertMaker = watchConsoleAllowingRefusals(maker);
  await maker.goto("/finance/journals/new");
  await expect(maker.getByRole("heading", { level: 1, name: "New journal" })).toBeVisible();
  await maker.getByLabel("Narration").fill(`Hydraulic press repair paid in cash (E2E ${STAMP})`);
  await pickAccount(maker, "line-1-account", "5420");
  await maker.locator("#line-1-debit").fill("1500");
  await pickAccount(maker, "line-2-account", "1100");
  await maker.locator("#line-2-credit").fill("1499");
  await expect(maker.getByRole("button", { name: "Save draft" })).toBeDisabled(); // unbalanced
  await expect(maker.getByRole("status")).toContainText("1.00");
  await maker.locator("#line-2-credit").fill("1500");
  await expect(maker.getByRole("status")).toContainText("Balanced");
  await shot(maker, "40-journal-new");
  await maker.getByRole("button", { name: "Save draft" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: "Draft journal" })).toBeVisible();
  await expect(maker.getByText("You prepared this journal, so another person posts it")).toBeVisible();
  // The preparer may hold posting rights, but never for their own journal: the server refuses and the UI says why.
  await maker.getByRole("button", { name: "Post" }).click();
  await stepUp(state.maker!);
  // Refused by the journal segregation-of-duties rule (403 code "sod"): the server's reason plus the next step.
  await expect(maker.getByRole("alert").filter({ hasText: "This would combine duties that must stay with different people." }))
    .toContainText("You prepared this journal; a second person with posting rights must post it.");
  await shot(maker, "41-journal-maker-refused");
  state.journalUrl = new URL(maker.url()).pathname;
  assertMaker();

  const checker = state.checker!.page;
  const assertChecker = watchConsole(checker);
  await checker.goto(state.journalUrl);
  await checker.getByRole("button", { name: "Post" }).click();
  await stepUp(state.checker!);
  await expect(checker.getByRole("heading", { level: 1, name: /^Journal JE/ })).toBeVisible();
  const number = (await checker.getByRole("heading", { level: 1 }).innerText()).replace("Journal ", "");
  await expect(checker.getByText("Posted entries can't be edited.")).toBeVisible();
  await expect(checker.getByRole("button", { name: "Post" })).toHaveCount(0);
  await shot(checker, "42-journal-posted");

  await checker.getByRole("button", { name: "Reverse" }).click();
  await checker.getByLabel("Reason").fill("Repair was billed to the supplier instead");
  await shot(checker, "43-journal-reverse-dialog");
  await checker.getByRole("button", { name: "Post reversal" }).click();
  await stepUp(state.checker!);
  await expect(checker.getByText("Reversal", { exact: true }).first()).toBeVisible();
  await expect(checker.getByText(`Reversal of ${number}: Repair was billed to the supplier instead`)).toBeVisible();
  await expect(checker.getByRole("link", { name: "the original entry" })).toBeVisible();
  await shot(checker, "44-journal-reversal");
  await checker.getByRole("link", { name: "the original entry" }).click();
  await expect(checker.getByText("Reversed", { exact: true }).first()).toBeVisible();
  await expect(checker.getByRole("button", { name: "Reverse" })).toHaveCount(0);

  await checker.goto("/finance/journals");
  await expect(checker.getByRole("row", { name: new RegExp(`^${number} `) })).toContainText("Reversed");

  await checker.goto("/finance/reports");
  await expect(checker.getByRole("status")).toContainText("Balanced: debits equal credits");
  await expect(checker.getByRole("button", { name: /Open ledger for 5420 Repairs and maintenance/ })).toBeVisible();
  await shot(checker, "45-trial-balance");
  await checker.getByRole("button", { name: /Open ledger for 5420 Repairs and maintenance/ }).click();
  await expect(checker.getByRole("link", { name: number })).toBeVisible();
  await expect(checker.getByText("Closing balance")).toBeVisible();
  await shot(checker, "46-account-ledger");
  await checker.goto("/finance/reports?view=balance-sheet");
  await expect(checker.getByRole("status")).toContainText("Balanced: assets equal liabilities plus equity");
  await shot(checker, "47-balance-sheet");
  await checker.goto("/finance/reports?view=profit-and-loss");
  await expect(checker.getByText("Total expenses")).toBeVisible();
  await shot(checker, "48-profit-and-loss");
  assertChecker();
});

test("supplier invoices from goods receipt lines: clean match posts; quantity mismatch refused; price variance rejected, re-submitted, approved within limit, posted", async () => {
  test.setTimeout(240_000);
  const maker = state.maker!.page;
  const assertMaker = watchConsoleAllowingRefusals(maker);
  const vendorCode = `VEN-${STAMP}`;
  const record = async (number: string, quantity: string, rate?: string) => {
    await maker.goto("/finance/payables");
    await maker.getByRole("link", { name: "Record invoice" }).click();
    await expect(maker.getByRole("heading", { level: 1, name: "Record a supplier invoice" })).toBeVisible();
    await pickPartner(maker, maker.locator("#supplier"), vendorCode, state.vendorName!);
    await pickSelect(maker, maker.locator("#receipt"), new RegExp(esc(state.grnNumber!)));
    await maker.getByLabel("Supplier's invoice number").fill(number);
    await maker.getByLabel("Invoice date").fill(lastMonthInvoiceDate);
    const qty = maker.getByLabel(`Billed quantity ${state.item!.code}`);
    await expect(qty).not.toHaveValue("");
    await qty.fill(quantity);
    if (rate) await maker.getByLabel(`Billed rate ${state.item!.code}`).fill(rate);
  };

  // A: 60 of 100 received, at the order rate → three-way matched, approved by the match itself, posted.
  await record(`DF/${STAMP}/01`, "60");
  await expect(maker.getByRole("table", { name: "Receipt lines" })).toContainText("100.000");
  await shot(maker, "49-supplier-invoice-new");
  await mobile(maker, "49-supplier-invoice-new");
  await maker.getByRole("button", { name: "Save draft" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: `${state.vendorName} · DF/${STAMP}/01` })).toBeVisible();
  await expect(maker.getByText("Not matched yet").first()).toBeVisible();
  await maker.getByRole("button", { name: "Submit for matching" }).click();
  await expect(maker.getByText("Three-way matched").first()).toBeVisible();
  await expect(maker.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(maker.getByText("Quantities and rates agree with the receipt and the order.")).toBeVisible();
  await maker.getByRole("button", { name: "Post to ledger" }).click();
  await expect(maker.getByText("Posted", { exact: true }).first()).toBeVisible();
  await expect(maker.getByRole("link", { name: "Open journal" })).toBeVisible();
  await expect(maker.getByText(/^PI/).first()).toBeVisible();
  await shot(maker, "49b-supplier-invoice-posted");
  state.invoiceAUrl = new URL(maker.url()).pathname;

  // B: bills 45 when only 40 are still open to invoice → the match refuses and lists the line.
  await record(`DF/${STAMP}/02`, "45", "262.5");
  await maker.getByRole("button", { name: "Save draft" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: `${state.vendorName} · DF/${STAMP}/02` })).toBeVisible();
  await maker.getByRole("button", { name: "Submit for matching" }).click();
  const refused = maker.getByRole("alert").filter({ hasText: "The invoice doesn't match what was received." });
  await expect(refused).toContainText(`${state.item!.code}: billed 45, but only 40 is open to invoice.`);
  await expect(maker.getByText("Draft", { exact: true }).first()).toBeVisible();
  await shot(maker, "49c-supplier-invoice-quantity-refused");

  // C: the remaining 40 at 262.50 against the order rate 250 → price variance, sent for approval.
  await record(`DF/${STAMP}/03`, "40", "262.5");
  await maker.getByRole("button", { name: "Save draft" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: `${state.vendorName} · DF/${STAMP}/03` })).toBeVisible();
  await maker.getByRole("button", { name: "Submit for matching" }).click();
  await expect(maker.getByText("Price variance").first()).toBeVisible();
  await expect(maker.getByText("Awaiting approval").first()).toBeVisible();
  await expect(maker.getByRole("listitem").filter({ hasText: "billed at 262.50 against the order rate 250.00" })).toContainText("₹500.00");
  await expect(maker.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await shot(maker, "49d-supplier-invoice-variance");
  state.invoiceCUrl = new URL(maker.url()).pathname;

  const checker = state.checker!.page;
  const assertChecker = watchConsoleAllowingRefusals(checker);
  await checker.goto(state.invoiceCUrl);
  await expect(checker.getByText("Price variance").first()).toBeVisible();
  // Above the controller's approval limit (₹10,000): refused, and the reason is shown.
  await checker.getByRole("button", { name: "Approve" }).click();
  await checker.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(checker.getByRole("alert").filter({ hasText: "The amount is above your approval limit." })).toBeVisible();
  await expect(checker.getByText("Awaiting approval").first()).toBeVisible();
  await shot(checker, "49e-supplier-invoice-over-limit");
  // The controller raises their own role's limit (approval limits are upserted per role and document type).
  await call(state.checker!, "POST", "/authorization/approval-limits/", { role: state.checkerRoleId, document_type: "finance.supplier_invoice", currency: "INR", max_amount: "1000000.00" });

  // The controller rejects the variance with a reason; the accountant re-submits after talking to the vendor.
  await checker.reload();
  await checker.getByRole("button", { name: "Reject" }).click();
  await checker.getByLabel("Reason").fill("Rate revision not yet confirmed by purchase");
  await shot(checker, "49f-supplier-invoice-reject-dialog");
  await checker.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
  await expect(checker.getByText("Rejected", { exact: true }).first()).toBeVisible();

  await maker.goto(state.invoiceCUrl);
  await expect(maker.getByText("Rejected", { exact: true }).first()).toBeVisible();
  await maker.getByRole("button", { name: "Submit for matching" }).click();
  await expect(maker.getByText("Awaiting approval").first()).toBeVisible();

  await checker.goto(state.invoiceCUrl);
  await checker.getByRole("button", { name: "Approve" }).click();
  await checker.getByLabel("Comment (optional)").fill("Purchase confirmed the revised rate.");
  await checker.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(checker.getByText("Approved", { exact: true }).first()).toBeVisible();
  assertChecker();

  await maker.reload();
  await maker.getByRole("button", { name: "Post to ledger" }).click();
  await expect(maker.getByText("Posted", { exact: true }).first()).toBeVisible();
  await shot(maker, "49g-supplier-invoice-variance-posted");
  await mobile(maker, "49g-supplier-invoice-variance-posted");

  await maker.goto("/finance/payables");
  await expect(maker.getByRole("row", { name: new RegExp(`DF/${STAMP}/02`) })).toContainText("Draft");
  await expect(maker.getByRole("row", { name: new RegExp(`DF/${STAMP}/03`) })).toContainText("Posted");
  await expect(maker.getByRole("row", { name: new RegExp(`DF/${STAMP}/01`) })).toContainText("Three-way matched");
  await shot(maker, "49h-payables-invoices");
  assertMaker();
});

test("supplier payments: second approver, verified bank account to post, allocation and advance, rejection", async () => {
  test.setTimeout(240_000);
  const maker = state.maker!.page;
  const assertMaker = watchConsole(maker);
  const newPayment = async (code: string, name: string, bank: RegExp, reference: string, amount: string) => {
    await maker.goto("/finance/payments");
    await maker.getByRole("link", { name: "New payment" }).click();
    await expect(maker.getByRole("heading", { level: 1, name: "New supplier payment" })).toBeVisible();
    await pickPartner(maker, maker.locator("#partner"), code, name);
    await pickSelect(maker, maker.locator("#bank_account"), bank);
    await maker.getByLabel("Reference").fill(reference);
    await maker.getByLabel("Amount (₹)").fill(amount);
  };
  const hdfc = new RegExp(`HDFC Bank, Pune \\(E2E ${STAMP}\\)`);

  // An advance to a supplier with no verified bank account: approved by the controller, but posting is refused.
  await newPayment(`SUP-${STAMP}`, state.supplierName!, hdfc, `ADV-${STAMP}`, "2500");
  await expect(maker.getByText("No open invoices")).toBeVisible();
  await shot(maker, "50-payment-new");
  await maker.getByRole("button", { name: "Save draft" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /Supplier payment to Kaveri Castings/ })).toBeVisible();
  await maker.getByRole("button", { name: "Submit" }).click();
  await expect(maker.getByText("Awaiting approval").first()).toBeVisible();
  await expect(maker.getByRole("status").filter({ hasText: "Waiting for another approver" })).toBeVisible();
  await expect(maker.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await shot(maker, "51-payment-waiting-for-approver");
  const advanceUrl = new URL(maker.url()).pathname;

  const checker = state.checker!.page;
  const assertChecker = watchConsoleAllowingRefusals(checker);
  await checker.goto(advanceUrl);
  await checker.getByRole("button", { name: "Approve" }).click();
  await checker.getByLabel("Comment (optional)").fill("Advance agreed for the November castings order.");
  await checker.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await stepUp(state.checker!);
  await expect(checker.getByText("Approved", { exact: true }).first()).toBeVisible();
  await checker.getByRole("button", { name: "Post" }).click();
  await stepUp(state.checker!);
  await expect(checker.getByRole("alert").filter({ hasText: `${state.supplierName} has no verified bank account.` })).toBeVisible();
  await expect(checker.getByText("Approved", { exact: true }).first()).toBeVisible(); // nothing was posted
  await shot(checker, "52-payment-post-refused-unverified-bank");

  // The vendor's bank account was verified by a second person: pay invoice DF/01 in full plus ₹5,000 on account.
  const sbi = await call<{ amount: string }>(state.maker!, "GET", `${state.invoiceAUrl!.replace("/finance/payables/", "/finance/supplier-invoices/")}/`);
  expect(sbi.amount).toMatch(/^17700\.0+$/);
  await newPayment(`VEN-${STAMP}`, state.vendorName!, hdfc, `NEFT${STAMP}22700`, "22700");
  await maker.getByRole("checkbox", { name: `Allocate to DF/${STAMP}/01` }).check();
  await expect(maker.getByLabel(`Amount allocated to DF/${STAMP}/01`)).toHaveValue("17700");
  await expect(maker.getByRole("checkbox", { name: `Allocate to DF/${STAMP}/03` })).toBeVisible();
  await expect(maker.getByText("On account", { exact: true }).locator("..")).toContainText("₹5,000.00");
  await shot(maker, "53a-payment-allocated");
  await mobile(maker, "53a-payment-allocated");
  await maker.getByRole("button", { name: "Save draft" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /Supplier payment to Deccan Forgings/ })).toBeVisible();
  await maker.getByRole("button", { name: "Submit" }).click();
  await expect(maker.getByRole("status").filter({ hasText: "Waiting for another approver" })).toBeVisible();
  state.paymentUrl = new URL(maker.url()).pathname;

  await checker.goto(state.paymentUrl);
  await checker.getByRole("button", { name: "Approve" }).click();
  await checker.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await stepUp(state.checker!);
  await expect(checker.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(checker.getByText(`Posting checks that ${state.vendorName} has a verified bank account on file.`)).toBeVisible();
  await checker.getByRole("button", { name: "Post" }).click();
  await stepUp(state.checker!);
  await expect(checker.getByText("Posted", { exact: true }).first()).toBeVisible();
  await expect(checker.getByRole("heading", { level: 1 })).toContainText("Deccan Forgings");
  await expect(checker.getByText(/^PAY/).first()).toBeVisible();
  await expect(checker.getByRole("table", { name: "Allocations" })).toContainText(`DF/${STAMP}/01`);
  await expect(checker.getByRole("table", { name: "Allocations" })).toContainText("₹17,700.00");
  await expect(checker.getByRole("link", { name: "Ledger entry" })).toBeVisible();
  await shot(checker, "53b-payment-posted");
  await mobile(checker, "53b-payment-posted");

  // A second payment the controller rejects with a reason.
  await newPayment(`VEN-${STAMP}`, state.vendorName!, hdfc, `DUP-${STAMP}`, "1000");
  await maker.getByRole("button", { name: "Save draft" }).click();
  await maker.getByRole("button", { name: "Submit" }).click();
  await expect(maker.getByRole("status").filter({ hasText: "Waiting for another approver" })).toBeVisible();
  const duplicateUrl = new URL(maker.url()).pathname;
  await checker.goto(duplicateUrl);
  await checker.getByRole("button", { name: "Reject" }).click();
  await checker.getByLabel("Reason").fill("Duplicate of the NEFT already sent");
  await checker.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
  await stepUp(state.checker!);
  await expect(checker.getByText("Rejected", { exact: true }).first()).toBeVisible();
  await shot(checker, "53c-payment-rejected");

  await maker.goto("/finance/payments?kind=supplier_payment");
  await expect(maker.getByRole("row", { name: new RegExp(`DUP-${STAMP}`) })).toContainText("Rejected");
  await expect(maker.getByRole("row", { name: new RegExp(`NEFT${STAMP}22700`) })).toContainText("Posted");
  assertChecker();
  assertMaker();
});

test("apply credit: a supplier advance and a customer receipt settle open invoices, from payables, receivables and payments", async () => {
  test.setTimeout(150_000);
  const maker = state.maker!.page;
  const assertMaker = watchConsole(maker);

  await maker.goto("/finance/payables");
  await maker.getByRole("button", { name: "Apply credit" }).click();
  let dialog = maker.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Apply a credit to an invoice" })).toBeVisible();
  await pickPartner(maker, dialog.locator("#credit-partner"), `VEN-${STAMP}`, state.vendorName!);
  await dialog.getByRole("group", { name: "Credit to use" }).getByRole("radio").first().check();
  await dialog.getByRole("group", { name: "Invoice to settle" }).getByRole("radio", { name: new RegExp(`DF/${STAMP}/03`) }).check();
  await expect(dialog.getByLabel("Amount to apply")).toHaveValue("5000.00");
  await expect(dialog.getByText("Up to ₹5,000.00")).toBeVisible();
  await dialog.getByLabel("Amount to apply").fill("6000");
  await expect(dialog.getByText("At most ₹5,000.00.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
  await dialog.getByLabel("Amount to apply").fill("5000");
  await shot(maker, "54a-apply-credit-payable");
  await mobile(maker, "54a-apply-credit-payable");
  await dialog.getByRole("button", { name: "Apply ₹5,000.00" }).click();
  await expect(maker.getByText(`₹5,000.00 of PAY`)).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await maker.getByRole("tab", { name: "Open payables" }).click();
  const invoiceC = maker.getByRole("row", { name: new RegExp(`DF/${STAMP}/03`) });
  await expect(invoiceC).toContainText("₹12,390.00");
  await expect(invoiceC).toContainText("₹7,390.00");
  await expect(maker.getByRole("row", { name: new RegExp(`DF/${STAMP}/01`) })).toHaveCount(0); // paid in full
  await shot(maker, "54b-open-payables-after-credit");

  // The customer's ₹5,000 receipt is on account: apply ₹2,000 from Receivables and the rest from Payments.
  await maker.goto("/finance/receivables");
  await expect(maker.getByRole("row", { name: new RegExp(esc(state.salesInvoice!)) })).toContainText("₹67,968.00");
  await maker.getByRole("button", { name: "Apply credit" }).click();
  dialog = maker.getByRole("dialog");
  await pickPartner(maker, dialog.locator("#credit-partner"), `CUS-${STAMP}`, state.customerName!);
  await dialog.getByRole("group", { name: "Credit to use" }).getByRole("radio", { name: /^RCT/ }).check();
  await dialog.getByRole("group", { name: "Invoice to settle" }).getByRole("radio", { name: new RegExp(esc(state.salesInvoice!)) }).check();
  await dialog.getByLabel("Amount to apply").fill("2000");
  await dialog.getByRole("button", { name: "Apply ₹2,000.00" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(maker.getByRole("row", { name: new RegExp(esc(state.salesInvoice!)) })).toContainText("₹65,968.00");
  await expect(maker.getByRole("row", { name: /^RCT/ }).filter({ hasText: state.customerName! })).toContainText("−₹3,000.00");
  await shot(maker, "54c-receivables-after-credit");

  await maker.goto("/finance/payments");
  await maker.getByRole("button", { name: "Apply customer credit" }).click();
  dialog = maker.getByRole("dialog");
  await pickPartner(maker, dialog.locator("#credit-partner"), `CUS-${STAMP}`, state.customerName!);
  await dialog.getByRole("group", { name: "Credit to use" }).getByRole("radio").first().check();
  await dialog.getByRole("group", { name: "Invoice to settle" }).getByRole("radio").first().check();
  await expect(dialog.getByLabel("Amount to apply")).toHaveValue("3000.00");
  await dialog.getByRole("button", { name: "Apply ₹3,000.00" }).click();
  await expect(dialog).toHaveCount(0);
  await maker.getByRole("button", { name: "Apply customer credit" }).click();
  await pickPartner(maker, dialog.locator("#credit-partner"), `CUS-${STAMP}`, state.customerName!);
  await expect(dialog.getByText("No open credits for this customer")).toBeVisible();
  await shot(maker, "54d-apply-credit-none-left");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await maker.goto("/finance/receivables?view=ageing");
  await expect(maker.getByRole("row", { name: new RegExp(esc(state.customerName!)) })).toContainText("₹62,968.00");
  await shot(maker, "54e-receivables-ageing");
  assertMaker();
});

test("banking: ledger account and bank account added through the UI; statement import auto-matches, rejects duplicates, reconciles", async () => {
  test.setTimeout(150_000);
  const maker = state.maker!.page;
  const assertMaker = watchConsoleAllowingRefusals(maker);

  // A new bank ledger account in the chart, then the company bank account on top of it.
  await maker.goto("/finance/setup");
  await expect(maker.getByRole("table", { name: "Chart of accounts" })).toBeVisible();
  await maker.getByRole("button", { name: "Add account" }).click();
  let dialog = maker.getByRole("dialog");
  await dialog.getByLabel("Code").fill(`12${STAMP}`);
  await dialog.getByLabel("Name", { exact: true }).fill(`ICICI current account (E2E ${STAMP})`);
  await pickSelect(maker, dialog.locator("#acc-type"), "Asset");
  await pickSelect(maker, dialog.locator("#acc-sub"), "Bank");
  await pickAccount(maker, "acc-parent", "1000");
  await shot(maker, "55a-account-add-dialog");
  await dialog.getByRole("button", { name: "Add account" }).click();
  await expect(dialog).toHaveCount(0);
  const row = maker.getByRole("row", { name: new RegExp(`^12${STAMP} `) });
  await expect(row).toContainText("Bank");
  await row.getByRole("button", { name: `Edit 12${STAMP} ICICI current account (E2E ${STAMP})` }).click();
  dialog = maker.getByRole("dialog");
  await expect(dialog.getByLabel("Code")).toBeDisabled();
  await dialog.getByLabel("Name", { exact: true }).fill(`ICICI Bank current account, Pune (E2E ${STAMP})`);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(maker.getByRole("row", { name: new RegExp(`^12${STAMP} `) })).toContainText("ICICI Bank current account, Pune");

  await maker.goto("/finance/bank");
  await maker.getByRole("button", { name: "Add bank account" }).click();
  dialog = maker.getByRole("dialog");
  await pickAccount(maker, "bank-ledger", `12${STAMP}`);
  await dialog.getByLabel("Bank and branch").fill(`ICICI Bank, Hinjewadi (E2E ${STAMP})`);
  await dialog.getByLabel("IFSC").fill("icic0000456");
  await expect(dialog.getByLabel("IFSC")).toHaveValue("ICIC0000456");
  await dialog.getByLabel("Last 4 digits").pressSequentially("98x76");
  await expect(dialog.getByLabel("Last 4 digits")).toHaveValue("9876"); // letters are ignored as typed
  await shot(maker, "55b-bank-account-add-dialog");
  await mobile(maker, "55b-bank-account-add-dialog");
  await dialog.getByRole("button", { name: "Add account" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(maker.getByRole("button", { name: new RegExp(`ICICI Bank, Hinjewadi \\(E2E ${STAMP}\\)`) })).toHaveAttribute("aria-current", "true");
  await expect(maker.getByText("No statement imported yet")).toBeVisible();
  await expect(maker.getByText("No statement yet")).toBeVisible();
  await shot(maker, "55c-bank-account-added");

  const csv = [
    "date,description,reference,debit,credit,balance",
    `${today},NEFT receipt Sahyadri Motors,UTR${STAMP}5000,,5000.00,5000.00`,
    `${today},Bank charges October,CHG${STAMP},150.00,,4850.00`,
  ].join("\n");
  await maker.goto(`/finance/bank?account=${state.bankId}`);
  await expect(maker.getByRole("heading", { name: "Reconciliation" })).toBeVisible();
  await maker.getByLabel("Statement CSV", { exact: true }).fill(csv);
  await maker.getByRole("button", { name: "Import statement" }).click();
  await expect(maker.getByRole("status").filter({ hasText: "Imported 2 lines; 1 matched automatically." })).toBeVisible();
  await expect(statementRow(maker, /NEFT receipt Sahyadri Motors/)).toContainText("Matched");
  await expect(statementRow(maker, /Bank charges October/)).toContainText("Unmatched");
  await shot(maker, "56-bank-imported");

  await maker.getByLabel("Statement CSV", { exact: true }).fill(csv);
  await maker.getByRole("button", { name: "Import statement" }).click();
  await expect(maker.getByRole("alert").filter({ hasText: "Already imported" })).toBeVisible();
  await shot(maker, "57-bank-duplicate-rejected");

  // The bank charge is booked afterwards (prepared by the accountant, posted by the controller), then matched by hand.
  const je = await call<{ id: string; version: number }>(state.maker!, "POST", "/finance/journal-entries/", {
    company: state.companyId, entry_date: today, narration: `Bank charges October (E2E ${STAMP})`,
    lines: [
      { account: state.accounts!["5600"], debit: "150.00", credit: "0", description: "" },
      { account: state.bankLedgerId, debit: "0", credit: "150.00", description: "" },
    ],
  });
  await call(state.checker!, "POST", `/finance/journal-entries/${je.id}/post/`, { version: je.version }, idem());

  await maker.reload();
  await statementRow(maker, /Bank charges October/).getByRole("button", { name: "Match" }).click();
  dialog = maker.getByRole("dialog");
  await expect(dialog).toContainText(`Bank charges October (E2E ${STAMP})`);
  await shot(maker, "58-bank-manual-match");
  await dialog.getByRole("button", { name: "Match" }).click();
  await expect(statementRow(maker, /Bank charges October/)).toContainText("Matched");
  // The supplier payment from this account is still on the ledger only, waiting for the next statement.
  await expect(maker.getByRole("table", { name: "Unreconciled ledger entries" })).toContainText(/Supplier payment PAY/i);
  await expect(maker.getByText("0 statement · 1 ledger")).toBeVisible();
  await shot(maker, "59-bank-reconciliation");
  await mobile(maker, "59-bank-reconciliation");
  assertMaker();
});

test("GST returns: GSTR-1 lists the B2B invoice and HSN summary, GSTR-3B nets output tax against input credit", async () => {
  test.setTimeout(90_000);
  const page = state.maker!.page;
  const assertClean = watchConsole(page);
  await page.goto("/finance/gst"); // defaults to last month, when the sale and both supplier invoices were dated
  await expect(page.getByRole("heading", { level: 1, name: "GST returns" })).toBeVisible();
  const b2b = page.getByRole("table", { name: "B2B invoices" });
  await expect(b2b.getByRole("row", { name: new RegExp(esc(state.salesInvoice!)) })).toContainText("29AABCK5678D1Z9");
  await expect(b2b.getByRole("row", { name: new RegExp(esc(state.salesInvoice!)) })).toContainText("57,600.00");
  await expect(b2b.getByRole("row", { name: new RegExp(esc(state.salesInvoice!)) })).toContainText("10,368.00"); // IGST 18%
  await expect(page.getByRole("table", { name: "HSN summary" }).getByRole("row", { name: new RegExp(`^${HSN} `) })).toContainText("48.000");
  await shot(page, "60a-gstr1");
  await mobile(page, "60a-gstr1");

  await page.getByRole("tab", { name: "GSTR-3B" }).click();
  await expect(page.getByText("Outward taxable value").locator("..")).toContainText("₹57,600.00");
  const summary = page.getByRole("table", { name: "GSTR-3B tax summary" });
  await expect(summary.getByRole("row", { name: /^Output tax on outward supplies/ })).toContainText("₹10,368.00");
  await expect(summary.getByRole("row", { name: /^Less: input tax credit/ })).toContainText("₹4,590.00"); // 18% of 15,000 + 10,500
  await shot(page, "60b-gstr3b");
  await mobile(page, "60b-gstr3b");

  // A range with no postings says so instead of showing zero tables.
  await page.getByRole("tab", { name: "GSTR-1" }).click();
  await page.getByRole("button", { name: "This month" }).click();
  await expect(page.getByRole("table", { name: "B2B invoices" })).toHaveCount(0);
  await expect(page.getByText("Nothing in this period.").first()).toBeVisible();
  assertClean();
});

test("dashboards: missing data says so, and restricted widgets are named without values", async () => {
  test.setTimeout(60_000);
  const checker = state.checker!.page;
  const assertChecker = watchConsole(checker);
  await checker.goto("/analytics?d=management");
  await expect(checker.getByRole("tab", { name: "Management" })).toHaveAttribute("data-state", "active");
  await expect(checker.getByTestId("kpi-cash_position")).toContainText("₹");
  // Nothing was sold this month: DSO and DPO can't be computed, and must not read as 0.
  await expect(checker.getByTestId("kpi-dso")).toHaveText(/Not enough data/);
  await expect(checker.getByTestId("kpi-dpo")).toHaveText(/Not enough data/);
  await shot(checker, "61-dashboard-management");
  await checker.goto("/analytics?d=finance");
  // No budget has been approved yet: no variance, rather than a misleading zero.
  await expect(checker.getByTestId("kpi-budget_variance")).toHaveText(/Not enough data/);
  await shot(checker, "61b-dashboard-finance");
  assertChecker();

  const viewer = state.viewer!.page;
  const assertViewer = watchConsole(viewer);
  await viewer.goto("/analytics?d=finance");
  await expect(viewer.getByRole("heading", { name: "Not shown to you" })).toBeVisible();
  await expect(viewer.getByTestId("hidden-cash_position")).toContainText("Cash position");
  await expect(viewer.getByTestId("hidden-cash_position")).toContainText("needs finance.report.read");
  await expect(viewer.getByTestId("hidden-invoices_on_hold")).toContainText("needs finance.supplier_invoice.read");
  await expect(viewer.getByTestId("kpi-cash_position")).toHaveCount(0);
  await expect(viewer.getByText("₹")).toHaveCount(0);
  await shot(viewer, "62-dashboard-restricted");
  await viewer.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(viewer);
  await shot(viewer, "62m-dashboard-restricted-mobile");
  assertViewer();
});

test("budgets: created with monthly lines, draft edited, preparer refused, approved by another person, compared with actuals", async () => {
  test.setTimeout(180_000);
  const maker = state.maker!.page;
  const assertMaker = watchConsoleAllowingRefusals(maker);
  const name = `Operating budget (E2E ${STAMP})`;
  await maker.goto("/finance/budgets");
  await expect(maker.getByRole("heading", { level: 1, name: "Budgets" })).toBeVisible();
  await expect(maker.getByText("Approved budgets this year", { exact: true }).locator("..")).toContainText("0");
  await maker.getByRole("button", { name: "New budget" }).click();
  await expect(maker.getByRole("heading", { name: "New budget" })).toBeVisible();
  await maker.getByLabel("Name").fill(name);
  await expect(maker.locator("#budget-year")).toContainText(`${fyStartYear}`);
  const line1 = maker.getByRole("group", { name: "Line 1" });
  await pickAccountIn(maker, line1.getByRole("combobox", { name: "Account" }), "5100");
  await line1.getByLabel("Annual amount").fill("120000");
  await line1.getByRole("button", { name: "Spread evenly" }).click();
  await expect(line1.getByText("Line total")).toContainText("₹1,20,000.00");
  await maker.getByRole("button", { name: "Add line" }).click();
  const line2 = maker.getByRole("group", { name: "Line 2" });
  await pickAccountIn(maker, line2.getByRole("combobox", { name: "Account" }), "5100");
  await expect(line2.getByText("This account and cost centre already have a row; combine them.")).toBeVisible();
  await expect(maker.getByRole("button", { name: "Create draft" })).toBeDisabled();
  await pickAccountIn(maker, line2.getByRole("combobox", { name: "Account" }), "5600");
  await line2.getByLabel("Annual amount").fill("1000.10");
  await line2.getByRole("button", { name: "Spread evenly" }).click();
  await expect(line2.getByText("Line total")).toContainText("₹1,000.10");
  await shot(maker, "63a-budget-new");
  await mobile(maker, "63a-budget-new");
  await maker.getByRole("button", { name: "Create draft" }).click();
  await expect(maker.getByText(name).first()).toBeVisible();
  const lines = maker.getByRole("table", { name: "Budget lines by month" });
  await expect(lines.getByRole("row", { name: /5100 / })).toContainText("₹1,20,000.00");
  await expect(lines.getByRole("row", { name: /5600 / })).toContainText("₹1,000.10");
  await expect(maker.getByText("You prepared this budget, so a colleague with budget approval rights must approve it.")).toBeVisible();

  // Edit the draft: rename it and raise the bank-charges line.
  await maker.getByRole("button", { name: "Edit" }).click();
  await expect(maker.getByRole("heading", { name: `Edit ${name}` })).toBeVisible();
  await maker.getByLabel("Name").fill(`${name} rev 1`);
  const edit2 = maker.getByRole("group", { name: "Line 2" });
  await edit2.getByLabel("Annual amount").fill("2400");
  await edit2.getByRole("button", { name: "Spread evenly" }).click();
  await maker.getByRole("button", { name: "Save draft" }).click();
  await expect(maker.getByText(`${name} rev 1`).first()).toBeVisible();
  await expect(maker.getByRole("table", { name: "Budget lines by month" }).getByRole("row", { name: /5600 / })).toContainText("₹2,400.00");

  // The preparer holds budget approval rights, but not for their own budget.
  await maker.getByRole("button", { name: "Approve", exact: true }).click();
  await maker.getByRole("alertdialog").getByRole("button", { name: "Approve budget" }).click();
  await expect(maker.getByRole("alert").filter({ hasText: "You can't approve or decide something you created or submitted." }))
    .toContainText("Ask a colleague with budget approval rights to approve it.");
  await expect(maker.getByText("Draft", { exact: true }).first()).toBeVisible();
  await shot(maker, "63b-budget-preparer-refused");
  const budgetUrl = new URL(maker.url());
  assertMaker();

  const checker = state.checker!.page;
  const assertChecker = watchConsole(checker);
  await checker.goto("/finance/budgets");
  await checker.getByRole("row", { name: new RegExp(esc(`${name} rev 1`)) }).click();
  await expect(checker).toHaveURL(new RegExp(`budget=${budgetUrl.searchParams.get("budget")}`));
  await checker.getByRole("button", { name: "Approve", exact: true }).click();
  await shot(checker, "63c-budget-approve-confirm");
  await checker.getByRole("alertdialog").getByRole("button", { name: "Approve budget" }).click();
  await expect(checker.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(checker.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  // Actuals: cost of the 48 flanges delivered at ₹250, and the ₹150 bank charge.
  const vs = checker.getByRole("table", { name: "Budget against actual" });
  await expect(vs.getByRole("row", { name: /5100 / })).toContainText("₹12,000.00");
  await expect(vs.getByRole("row", { name: /5100 / })).toContainText("₹1,08,000.00");
  await expect(vs.getByRole("row", { name: /5600 / })).toContainText("₹150.00");
  await expect(checker.getByText("Approved budgets this year", { exact: true }).locator("..")).toContainText("1");
  await expect(checker.getByText("Variance (planned − actual)", { exact: true }).locator("..")).not.toContainText("Not enough data");
  await shot(checker, "63d-budget-approved-vs-actual");
  await mobile(checker, "63d-budget-approved-vs-actual");
  await checker.goto("/finance/budgets?status=approved");
  await expect(checker.getByRole("row", { name: new RegExp(esc(`${name} rev 1`)) })).toContainText("Approved");
  await checker.goto("/analytics?d=finance");
  await expect(checker.getByTestId("kpi-budget_variance")).toContainText("₹");
  assertChecker();
});

test("accounting setup: cost centres and posting rules added and edited (with step-up verification)", async () => {
  test.setTimeout(150_000);
  const maker = state.maker!.page;
  const assertMaker = watchConsole(maker);
  await maker.goto("/finance/setup?view=cost-centres");
  await maker.getByRole("button", { name: "Add cost centre" }).click();
  let dialog = maker.getByRole("dialog");
  await dialog.getByLabel("Code").fill(`CC${STAMP}`);
  await dialog.getByLabel("Name").fill("Machining shop");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  const cc = maker.getByRole("row", { name: new RegExp(`^CC${STAMP} `) });
  await expect(cc).toContainText("Machining shop");
  await cc.getByRole("button", { name: `Edit CC${STAMP}` }).click();
  dialog = maker.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Machining shop, Pune");
  await dialog.getByRole("checkbox", { name: "Active" }).uncheck();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cc).toContainText("Machining shop, Pune");
  await expect(cc).toContainText("Inactive");
  await shot(maker, "64a-cost-centres");

  await maker.goto("/finance/setup?view=rules");
  await expect(maker.getByRole("table", { name: "Posting rules" })).toContainText("grni");
  await maker.getByRole("button", { name: "Add rule" }).click();
  dialog = maker.getByRole("dialog");
  await dialog.getByLabel("Posting key").fill("inventory");
  await dialog.getByLabel("Item group").fill(`G${STAMP}`);
  await pickAccount(maker, "rule-account", "1330");
  await shot(maker, "64b-posting-rule-dialog");
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await stepUp(state.maker!);
  await expect(dialog).toHaveCount(0);
  const rule = maker.getByRole("row", { name: new RegExp(`G${STAMP}`) });
  await expect(rule).toContainText("1330");
  await expect(rule).toContainText("Active");
  await rule.getByRole("button", { name: "Edit rule inventory" }).click();
  dialog = maker.getByRole("dialog");
  await expect(dialog.getByLabel("Posting key")).toBeDisabled();
  await pickAccount(maker, "rule-account", "1320");
  await dialog.getByRole("switch", { name: "Active" }).click();
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await stepUp(state.maker!);
  await expect(dialog).toHaveCount(0);
  await expect(rule).toContainText("1320");
  await expect(rule).toContainText("Inactive");
  await shot(maker, "64c-posting-rules");
  await mobile(maker, "64c-posting-rules");
  assertMaker();
});

test("period and year close: sub-ledger checks, order enforced, MFA step-up prompt, closing entry to retained earnings", async () => {
  test.setTimeout(300_000);
  const checker = state.checker!;
  const page = checker.page;
  const assertClean = watchConsoleAllowingRefusals(page);
  // Last fiscal year's first ten months are closed through the API; the UI closes the eleventh and the year.
  const prior = await call<{ code: string; periods: { id: string; period_no: number; status: string }[] }>(checker, "GET", `/organization/fiscal-years/${state.priorYearId}/`);
  for (const p of [...prior.periods].sort((x, y) => x.period_no - y.period_no).filter((x) => x.period_no <= 10 && x.status !== "closed")) {
    await call(checker, "POST", "/finance/close/period/", { period: p.id, force: false });
  }

  await page.goto("/finance/setup?view=close");
  await expect(page.getByRole("heading", { name: /^Close P11 / })).toBeVisible();
  const checks = page.getByRole("table", { name: "Sub-ledger reconciliation" });
  await expect(checks).toContainText("Inventory (stock ledger)");
  await expect(checks).toContainText("Receivables (open items)");
  await expect(checks).toContainText("Payables (open items)");
  await expect(checks.getByLabel("Agrees")).toHaveCount(3);

  // A sensitive action after the verification window: the step-up prompt appears; a wrong code is refused.
  if (STEP_UP_MS <= 120_000) {
    const wait = STEP_UP_MS + 3_000 - (Date.now() - checker.verifiedAt);
    if (wait > 0) await page.waitForTimeout(wait);
    await page.getByRole("button", { name: "Close period" }).click();
    const dialog = stepUpDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Verification code").fill("000000");
    await dialog.getByRole("button", { name: "Verify and continue" }).click();
    await expect(dialog.getByText("That code didn't work. Try the current one.")).toBeVisible();
    await shot(page, "65a-step-up-prompt");
    await mobile(page, "65a-step-up-prompt");
    await dialog.getByLabel("Verification code").fill(await freshCode(checker));
    await dialog.getByRole("button", { name: "Verify and continue" }).click();
    await expect(dialog).toHaveCount(0);
    checker.verifiedAt = Date.now();
  } else {
    test.info().annotations.push({ type: "skipped-check", description: "step-up prompt: set ERP_STEP_UP_MINUTES=1 and E2E_STEP_UP_MINUTES=1" });
    await page.getByRole("button", { name: "Close period" }).click();
    await stepUp(checker);
  }
  await expect(page.getByText("Period closed")).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Close P12 / })).toBeVisible();
  await shot(page, "65b-period-closed");

  // The year closes its last period itself and moves the year's result to retained earnings.
  const year = page.getByRole("region", { name: `Fiscal year ${prior.code}` });
  await expect(year.getByRole("button", { name: /^P11 · / })).toContainText("Closed");
  await year.getByRole("button", { name: "Close year" }).click();
  await stepUp(checker);
  await expect(page.getByText("Fiscal year closed; the closing entry moved the year's result to retained earnings")).toBeVisible();
  await expect(year.getByRole("button", { name: "Close year" })).toHaveCount(0);
  await expect(year.getByText("Closed", { exact: true }).first()).toBeVisible();
  await expect(year.getByRole("button", { name: /^P12 · / })).toContainText("Closed");
  await shot(page, "65c-year-closed");

  // Periods close in order: last month can't close while this year's earlier months are open.
  const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
  const periodNo = ((lastMonth.getMonth() - 3 + 12) % 12) + 1;
  await page.getByRole("region", { name: `Fiscal year ${state.currentYearCode}` }).getByRole("button", { name: new RegExp(`^P${periodNo} · `) }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`^Close P${periodNo} `) })).toBeVisible();
  await expect(checks.getByRole("row", { name: /Receivables \(open items\)/ })).toContainText("₹67,968.00");
  await expect(checks.getByLabel("Agrees")).toHaveCount(3);
  if (periodNo > 1) {
    await page.getByRole("button", { name: "Close period" }).click();
    await stepUp(checker);
    await expect(page.getByRole("alert").filter({ hasText: "Close earlier periods first." })).toBeVisible();
  }
  await shot(page, "65d-period-close-checks");
  await mobile(page, "65d-period-close-checks");

  await page.goto(`/finance/journals?q=${encodeURIComponent(`Year-end closing ${prior.code}`)}`);
  await page.getByRole("row", { name: new RegExp(`Year-end closing ${esc(prior.code)}`) }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Journal / })).toBeVisible();
  const closing = page.getByRole("table", { name: "Journal lines" });
  await expect(closing.getByRole("row", { name: /5420 / })).toContainText("2,000.00");
  await expect(closing).toContainText("Retained earnings");
  await shot(page, "65e-year-end-closing-entry");
  assertClean();
});

test("report export: request, wait for the background job, download the CSV", async () => {
  test.setTimeout(90_000);
  const maker = state.maker!.page;
  const assertMaker = watchConsole(maker);
  await maker.goto("/analytics/reports");
  await maker.locator("#report-type").click();
  await maker.getByRole("option", { name: "Trial balance" }).click();
  await expect(maker.getByLabel("From")).toBeVisible();
  await maker.getByRole("button", { name: "Request export" }).click();
  const row = maker.getByRole("row", { name: /Trial balance/ }).first();
  await expect(row).toContainText("Ready", { timeout: 45_000 });
  await shot(maker, "66-report-export-ready");
  const [download] = await Promise.all([maker.waitForEvent("download"), row.getByRole("button", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^trial_balance-\d{8}\.csv$/);
  const body = readFileSync((await download.path())!, "utf8");
  expect(body.split("\n")[0]).toContain("code,name,account_type,opening,debit,credit,closing");
  expect(body).toContain(`11${STAMP},HDFC current account (E2E ${STAMP})`);
  assertMaker();
});

test("demand forecast from four months of stock history", async () => {
  test.setTimeout(90_000);
  const maker = state.maker!.page;
  const assertMaker = watchConsole(maker);
  await maker.goto("/analytics/forecast");
  await expect(maker.getByRole("paragraph").filter({ hasText: "Choose an item" })).toBeVisible();
  await maker.locator("#forecast-item").click();
  await maker.getByPlaceholder("Item code or name").fill(state.item!.code);
  await maker.getByRole("option", { name: new RegExp(state.item!.code) }).click();
  await expect(maker).toHaveURL(new RegExp(`item=${state.item!.id}`));
  // Deliveries of 10, 14, 12 and 12 in the last four months: a 3-month moving average of 12.67.
  await expect(maker.getByText("Forecast per month").locator("..")).toContainText("12.67");
  await expect(maker.getByText("Mean absolute deviation").locator("..")).not.toContainText("Not enough data");
  await expect(maker.getByRole("img", { name: "Demand by month: 12 months of history and 3 forecast months" })).toBeVisible();
  await maker.getByText("Table view").click();
  const table = maker.getByRole("table", { name: "Monthly demand and forecast" });
  await expect(table.getByRole("row", { name: /Actual 14\.000/ })).toHaveCount(1);
  await expect(table.getByRole("row", { name: /Forecast/ })).toHaveCount(3);
  await shot(maker, "67a-forecast-moving-average");
  await mobile(maker, "67a-forecast-moving-average");
  await pickSelect(maker, maker.locator("#forecast-method"), "Exponential smoothing");
  await expect(maker.getByText("α = 0.30")).toBeVisible();
  await pickSelect(maker, maker.locator("#forecast-alpha"), "0.50");
  await expect(maker.getByText("α = 0.50")).toBeVisible();
  await pickSelect(maker, maker.locator("#forecast-horizon"), "6 mo");
  await expect(maker.getByText("6 months ahead")).toBeVisible();
  await shot(maker, "67b-forecast-exponential");
  assertMaker();
});

test("every finance and analytics screen renders on desktop and at 375px without sideways scroll", async () => {
  test.setTimeout(600_000); // ~28 routes × 2 viewports on a dev server
  const page = state.checker!.page;
  const assertClean = watchConsole(page);
  const routes: [string, string | RegExp, string][] = [
    ["/finance/reports", "Financial statements", "70-reports"],
    ["/finance/reports?view=balance-sheet", "Financial statements", "70b-balance-sheet"],
    ["/finance/reports?view=profit-and-loss", "Financial statements", "70c-profit-and-loss"],
    ["/finance/journals", "Journals", "71-journals"],
    [state.journalUrl!, /^Journal JE/, "71b-journal-detail"],
    ["/finance/payables", "Payables", "72-payables"],
    ["/finance/payables?view=open", "Payables", "72b-payables-open"],
    ["/finance/payables?view=ageing", "Payables", "72c-payables-ageing"],
    [state.invoiceCUrl!, new RegExp(esc(state.vendorName!)), "72d-supplier-invoice"],
    ["/finance/receivables", "Receivables", "73-receivables"],
    ["/finance/receivables?view=ageing", "Receivables", "73b-receivables-ageing"],
    ["/finance/payments", "Payments", "74-payments"],
    [state.paymentUrl!, /Supplier payment to/, "74b-payment-detail"],
    [`/finance/bank?account=${state.bankId}`, "Banking", "75-bank"],
    ["/finance/gst", "GST returns", "76-gst"],
    ["/finance/gst?view=gstr3b", "GST returns", "76b-gstr3b"],
    ["/finance/budgets", "Budgets", "77-budgets"],
    ["/finance/setup", "Accounting setup", "78-setup-accounts"],
    ["/finance/setup?view=rules", "Accounting setup", "78b-setup-rules"],
    ["/finance/setup?view=cost-centres", "Accounting setup", "78c-setup-cost-centres"],
    ["/finance/setup?view=close", "Accounting setup", "78d-setup-close"],
    ["/analytics?d=management", "Dashboards", "79-dashboard-management"],
    ["/analytics?d=finance", "Dashboards", "79b-dashboard-finance"],
    ["/analytics/reports", "Report exports", "80-report-exports"],
    [`/analytics/forecast?item=${state.item!.id}`, "Demand forecast", "81-forecast"],
    ["/finance/journals/new", "New journal", "82-journal-new"],
    ["/finance/payments/new?kind=customer_receipt", "Record a customer receipt", "83-receipt-new"],
  ];
  for (const [path, heading, name] of routes) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0, { timeout: 15_000 });
    await shot(page, name);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(250);
    await expectNoHorizontalScroll(page);
    await shot(page, `${name}-375`);
  }
  assertClean();
  for (const s of [state.maker, state.checker, state.viewer, state.ops]) await s?.context.close();
});
