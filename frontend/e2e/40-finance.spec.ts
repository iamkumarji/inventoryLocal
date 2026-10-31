import { readFileSync } from "node:fs";

import { type Browser, type BrowserContext, expect as baseExpect, type Page, test } from "@playwright/test";

import { currentStep, expectNoHorizontalScroll, loadAdmin, saveAdmin, shot, totp, watchConsole } from "./helpers";

/*
 * Finance and analytics screens against the real API. Setup data (flags, roles, people, partners, a bank
 * account, a customer receipt) is created through the API by the people who are allowed to create it;
 * the behaviour under test is driven through the UI.
 *
 * People: Arun prepares (maker), Kavya checks and posts (checker), Vikram may only open dashboards.
 */

test.describe.configure({ mode: "serial" });
// The dev server compiles each route on first visit; give navigations after an action time to land.
const expect = baseExpect.configure({ timeout: 15_000 });

const STAMP = Date.now().toString(36).slice(-5).toUpperCase();
const NEW_PASSWORD = "Ledger-Checker-Passphrase-2026";
const TEMP = "Temp-Finance-Passw0rd-2026";
const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time

type Session = { context: BrowserContext; page: Page; csrf: string; secret?: string };
const state: {
  orgId?: string; companyId?: string; checkerRoleId?: string;
  maker?: Session; checker?: Session; viewer?: Session;
  supplierId?: string; supplierName?: string; customerId?: string; bankId?: string; bankLedgerId?: string;
  accounts?: Record<string, string>; journalUrl?: string;
} = {};

function baseURL() {
  return (test.info().project.use.baseURL as string | undefined) ?? "http://localhost:3000";
}

async function csrfOf(context: BrowserContext) {
  return (await context.cookies()).find((c) => c.name === "erp_csrf")?.value ?? "";
}

async function call<T = Record<string, unknown>>(s: Session, method: string, path: string, data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await s.context.request.fetch(`/api/v1${path}`, {
    method, data, headers: { "X-CSRF-Token": s.csrf || (await csrfOf(s.context)), ...headers },
  });
  if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${await res.text()}`);
  s.csrf = await csrfOf(s.context);
  return (res.status() === 204 ? null : await res.json()) as T;
}

async function newSession(browser: Browser): Promise<Session> {
  const context = await browser.newContext({ baseURL: baseURL(), viewport: { width: 1440, height: 900 } });
  return { context, page: await context.newPage(), csrf: "" };
}

/** First sign-in of a new person through the API: enrol TOTP when required, replace the temporary password. */
async function onboard(browser: Browser, email: string, mfa: boolean): Promise<Session> {
  const s = await newSession(browser);
  const login = await call<{ status: string }>(s, "POST", "/auth/login/", { email, password: TEMP, client_type: "web" });
  if (mfa) {
    expect(login.status).toBe("mfa_enrollment_required");
    const setup = await call<{ secret: string }>(s, "POST", "/auth/mfa/totp/setup/");
    await call(s, "POST", "/auth/mfa/totp/confirm/", { code: totp(setup.secret) });
    s.secret = setup.secret;
  }
  await call(s, "POST", "/auth/password/change/", { current_password: TEMP, new_password: NEW_PASSWORD });
  return s;
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

const statementRow = (page: Page, name: RegExp) => page.getByRole("table", { name: "Bank statement lines" }).getByRole("row", { name });

async function pickAccount(page: Page, triggerId: string, code: string) {
  const trigger = page.locator(`#${triggerId}`);
  await trigger.click();
  await page.getByRole("dialog").getByPlaceholder("Code or name").fill(code);
  await page.getByRole("option", { name: new RegExp(`^${code}\\b`) }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toContainText(code);
  await expect(page.locator("[data-slot=popover-content]")).toHaveCount(0); // closing animation finished
}

test("setup: modules, roles, people and finance master data", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = loadAdmin();
  const a = await newSession(browser);
  const login = await call<{ status: string; challenge_token: string }>(a, "POST", "/auth/login/", { email: "admin@demo.local", password: admin.password, client_type: "web" });
  expect(login.status).toBe("mfa_required");
  while (currentStep() <= admin.lastStep) await new Promise((r) => setTimeout(r, 1000));
  const step = currentStep();
  await call(a, "POST", "/auth/login/mfa/", { challenge_token: login.challenge_token, code: totp(admin.secret) });
  saveAdmin({ ...admin, lastStep: step });

  const me = await call<{ user: { organization_id: string }; active_company_id: string }>(a, "GET", "/auth/me/");
  state.orgId = me.user.organization_id;
  state.companyId = me.active_company_id;

  // Modules start disabled. NOTE: PATCH /admin/feature-flags/{id}/ currently fails with a server error
  // (backend bug, reported); on the isolated e2e stack the flags were switched on beforehand, so only
  // flags that are still off are patched here.
  const flags = await call<{ id: string; key: string; enabled_default: boolean }[]>(a, "GET", "/admin/feature-flags/");
  for (const key of ["module.finance", "module.analytics", "module.partners"]) {
    const flag = flags.find((f) => f.key === key);
    expect(flag, key).toBeTruthy();
    if (!flag!.enabled_default) await call(a, "PATCH", `/admin/feature-flags/${flag!.id}/`, { enabled_default: true });
  }

  const perms = (await call<{ code: string }[]>(a, "GET", "/authorization/permissions/")).map((p) => p.code);
  const finance = perms.filter((c) => c.startsWith("finance."));
  const makerCodes = [
    ...finance.filter((c) => !/\.(approve|reject|self_approve)$/.test(c)),
    ...perms.filter((c) => c.startsWith("analytics.")),
    "partners.partner.create", "partners.partner.read", "partners.supplier.read", "partners.customer.read", "organization.fiscal_year.read",
  ];
  const checkerCodes = [
    ...finance.filter((c) => !c.endsWith(".self_approve")),
    "analytics.dashboard.read", "analytics.report.read", "authorization.approval_limit.read", "authorization.approval_limit.manage",
    "partners.partner.read", "partners.supplier.read", "partners.customer.read", "organization.fiscal_year.read",
  ];
  const role = (code: string, name: string, permission_codes: string[], mfa_required: boolean) =>
    call<{ id: string }>(a, "POST", "/authorization/roles/", { code: `${code}_${STAMP.toLowerCase()}`, name: `${name} ${STAMP}`, description: "E2E finance spec", permission_codes, mfa_required });
  const makerRole = await role("e2e_fin_maker", "E2E accountant", makerCodes, true);
  const checkerRole = await role("e2e_fin_checker", "E2E finance controller", checkerCodes, true);
  const viewerRole = await role("e2e_dash_viewer", "E2E dashboard viewer", ["analytics.dashboard.read"], false);
  state.checkerRoleId = checkerRole.id;

  const people = [
    { key: "maker", email: `arun.${STAMP.toLowerCase()}@demo.local`, name: `Arun Mehta (E2E ${STAMP})`, role: makerRole.id, mfa: true },
    { key: "checker", email: `kavya.${STAMP.toLowerCase()}@demo.local`, name: `Kavya Rao (E2E ${STAMP})`, role: checkerRole.id, mfa: true },
    { key: "viewer", email: `vikram.${STAMP.toLowerCase()}@demo.local`, name: `Vikram Shah (E2E ${STAMP})`, role: viewerRole.id, mfa: false },
  ] as const;
  for (const p of people) {
    const user = await call<{ id: string }>(a, "POST", "/identity/users/", {
      email: p.email, full_name: p.name, phone: "", default_company: state.companyId, mfa_enforced: p.mfa, temporary_password: TEMP,
    }, { "Idempotency-Key": crypto.randomUUID() });
    await call(a, "POST", "/authorization/role-assignments/", {
      user: user.id, role: p.role, scope_type: "organization", scope_id: state.orgId, include_descendants: true, reason: "E2E finance spec",
    }, { "Idempotency-Key": crypto.randomUUID() });
  }
  await a.context.close();

  state.maker = await onboard(browser, people[0].email, true);
  state.checker = await onboard(browser, people[1].email, true);
  state.viewer = await onboard(browser, people[2].email, false);

  // The finance controller sets the approval limit for their own role (a financial control the system admin can't touch).
  await call(state.checker, "POST", "/authorization/approval-limits/", {
    role: state.checkerRoleId, document_type: "finance.payment", currency: "INR", max_amount: "1000000.00",
  });

  const m = state.maker;
  const accounts = await call<{ id: string; code: string }[]>(m, "GET", "/finance/accounts/");
  state.accounts = Object.fromEntries(accounts.map((x) => [x.code, x.id]));
  state.supplierName = `Kaveri Castings (E2E ${STAMP})`;
  state.supplierId = (await call<{ id: string }>(m, "POST", "/partners/", { code: `SUP-${STAMP}`, name: state.supplierName, is_supplier: true, gst_registration: "unregistered", state_code: "27" })).id;
  state.customerId = (await call<{ id: string }>(m, "POST", "/partners/", { code: `CUS-${STAMP}`, name: `Sahyadri Motors (E2E ${STAMP})`, is_customer: true, gst_registration: "unregistered", state_code: "27" })).id;
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
  const posted = await call<{ status: string }>(m, "POST", `/finance/payments/${receipt.id}/post/`, { version: submitted.version }, { "Idempotency-Key": crypto.randomUUID() });
  expect(posted.status).toBe("posted");
});

test("manual journal: maker drafts, checker posts and reverses; trial balance stays balanced", async () => {
  test.setTimeout(90_000);
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
  await expect(maker.getByRole("alert").filter({ hasText: "The person who prepared it can't post it" })).toBeVisible();
  await shot(maker, "41-journal-maker-refused");
  state.journalUrl = new URL(maker.url()).pathname;
  assertMaker();

  const checker = state.checker!.page;
  const assertChecker = watchConsole(checker);
  await checker.goto(state.journalUrl);
  await checker.getByRole("button", { name: "Post" }).click();
  await expect(checker.getByRole("heading", { level: 1, name: /^Journal JE/ })).toBeVisible();
  const number = (await checker.getByRole("heading", { level: 1 }).innerText()).replace("Journal ", "");
  await expect(checker.getByText("Posted entries can't be edited.")).toBeVisible();
  await expect(checker.getByRole("button", { name: "Post" })).toHaveCount(0);
  await shot(checker, "42-journal-posted");

  await checker.getByRole("button", { name: "Reverse" }).click();
  await checker.getByLabel("Reason").fill("Repair was billed to the supplier instead");
  await shot(checker, "43-journal-reverse-dialog");
  await checker.getByRole("button", { name: "Post reversal" }).click();
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

test("supplier payment needs a second approver, and posting needs a verified supplier bank account", async () => {
  test.setTimeout(90_000);
  const maker = state.maker!.page;
  const assertMaker = watchConsole(maker);
  await maker.goto("/finance/payments");
  await maker.getByRole("link", { name: "New payment" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: "New supplier payment" })).toBeVisible();
  await maker.locator("#partner").click();
  await maker.getByPlaceholder("Name or code").fill(`SUP-${STAMP}`);
  await maker.getByRole("option", { name: new RegExp(state.supplierName!.replace(/[()]/g, "\\$&")) }).click();
  await maker.locator("#bank_account").click();
  await maker.getByRole("option", { name: new RegExp(`HDFC Bank, Pune \\(E2E ${STAMP}\\)`) }).click();
  await maker.getByLabel("Reference").fill(`ADV-${STAMP}`);
  await maker.getByLabel("Amount (₹)").fill("2500");
  await expect(maker.getByText("No open invoices")).toBeVisible();
  await shot(maker, "50-payment-new");
  await maker.getByRole("button", { name: "Save draft" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /Supplier payment to Kaveri Castings/ })).toBeVisible();
  await maker.getByRole("button", { name: "Submit" }).click();
  await expect(maker.getByText("Awaiting approval").first()).toBeVisible();
  await expect(maker.getByRole("status").filter({ hasText: "Waiting for another approver" })).toBeVisible();
  await expect(maker.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await shot(maker, "51-payment-waiting-for-approver");
  const paymentUrl = new URL(maker.url()).pathname;
  assertMaker();

  const checker = state.checker!.page;
  const assertChecker = watchConsoleAllowingRefusals(checker);
  await checker.goto(paymentUrl);
  await checker.getByRole("button", { name: "Approve" }).click();
  await checker.getByLabel("Comment (optional)").fill("Advance agreed for the November castings order.");
  await checker.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(checker.getByText("Approved", { exact: true }).first()).toBeVisible();
  await checker.getByRole("button", { name: "Post" }).click();
  await expect(checker.getByRole("alert").filter({ hasText: `${state.supplierName} has no verified bank account.` })).toBeVisible();
  await expect(checker.getByText("Approved", { exact: true }).first()).toBeVisible(); // nothing was posted
  await shot(checker, "52-payment-post-refused-unverified-bank");
  assertChecker();
});

test("bank statement import auto-matches, rejects duplicates, and reconciles after a manual match", async () => {
  test.setTimeout(90_000);
  const maker = state.maker!.page;
  const assertMaker = watchConsoleAllowingRefusals(maker);
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
  await shot(maker, "53-bank-imported");

  await maker.getByLabel("Statement CSV", { exact: true }).fill(csv);
  await maker.getByRole("button", { name: "Import statement" }).click();
  await expect(maker.getByRole("alert").filter({ hasText: "Already imported" })).toBeVisible();
  await shot(maker, "54-bank-duplicate-rejected");

  // The bank charge is booked afterwards (prepared by the accountant, posted by the controller), then matched by hand.
  const je = await call<{ id: string; version: number }>(state.maker!, "POST", "/finance/journal-entries/", {
    company: state.companyId, entry_date: today, narration: `Bank charges October (E2E ${STAMP})`,
    lines: [
      { account: state.accounts!["5600"], debit: "150.00", credit: "0", description: "" },
      { account: state.bankLedgerId, debit: "0", credit: "150.00", description: "" },
    ],
  });
  await call(state.checker!, "POST", `/finance/journal-entries/${je.id}/post/`, { version: je.version }, { "Idempotency-Key": crypto.randomUUID() });

  await maker.reload();
  await statementRow(maker, /Bank charges October/).getByRole("button", { name: "Match" }).click();
  const dialog = maker.getByRole("dialog");
  await expect(dialog).toContainText(`Bank charges October (E2E ${STAMP})`);
  await shot(maker, "55-bank-manual-match");
  await dialog.getByRole("button", { name: "Match" }).click();
  await expect(statementRow(maker, /Bank charges October/)).toContainText("Matched");
  await expect(maker.getByText("0 statement · 0 ledger")).toBeVisible();
  await expect(maker.getByText("Reconciled", { exact: true })).toBeVisible();
  await expect(maker.getByText("0 statement · 0 ledger")).toBeVisible();
  await shot(maker, "56-bank-reconciled");
  assertMaker();
});

test("dashboards: missing data says so, and restricted widgets are named without values", async () => {
  test.setTimeout(60_000);
  const checker = state.checker!.page;
  const assertChecker = watchConsole(checker);
  await checker.goto("/analytics?d=management");
  await expect(checker.getByRole("tab", { name: "Management" })).toHaveAttribute("data-state", "active");
  await expect(checker.getByTestId("kpi-cash_position")).toContainText("₹");
  // No sales or cost of sales were posted: DSO and DPO can't be computed, and must not read as 0.
  await expect(checker.getByTestId("kpi-dso")).toHaveText(/Not enough data/);
  await expect(checker.getByTestId("kpi-dpo")).toHaveText(/Not enough data/);
  await shot(checker, "60-dashboard-management");
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
  await shot(viewer, "61-dashboard-restricted");
  await viewer.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(viewer);
  await shot(viewer, "61m-dashboard-restricted-mobile");
  assertViewer();
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
  await shot(maker, "62-report-export-ready");
  const [download] = await Promise.all([maker.waitForEvent("download"), row.getByRole("button", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^trial_balance-\d{8}\.csv$/);
  const body = readFileSync((await download.path())!, "utf8");
  expect(body.split("\n")[0]).toContain("code,name,account_type,opening,debit,credit,closing");
  expect(body).toContain(`11${STAMP},HDFC current account (E2E ${STAMP})`);
  assertMaker();
});

test("every finance and analytics screen renders on desktop and at 375px without sideways scroll", async () => {
  test.setTimeout(420_000); // 18 routes × 2 viewports on a dev server
  const page = state.checker!.page;
  const assertClean = watchConsole(page);
  const routes: [string, string, string][] = [
    ["/finance/reports", "Financial statements", "70-reports"],
    ["/finance/journals", "Journals", "71-journals"],
    ["/finance/payables", "Payables", "72-payables"],
    ["/finance/payables?view=ageing", "Payables", "72b-payables-ageing"],
    ["/finance/receivables", "Receivables", "73-receivables"],
    ["/finance/receivables?view=ageing", "Receivables", "73b-receivables-ageing"],
    ["/finance/payments", "Payments", "74-payments"],
    [`/finance/bank?account=${state.bankId}`, "Banking", "75-bank"],
    ["/finance/gst", "GST returns", "76-gst"],
    ["/finance/gst?view=gstr3b", "GST returns", "76b-gstr3b"],
    ["/finance/budgets", "Budgets", "77-budgets"],
    ["/finance/setup", "Accounting setup", "78-setup-accounts"],
    ["/finance/setup?view=rules", "Accounting setup", "78b-setup-rules"],
    ["/finance/setup?view=cost-centres", "Accounting setup", "78c-setup-cost-centres"],
    ["/finance/setup?view=close", "Accounting setup", "78d-setup-close"],
    ["/analytics?d=finance", "Dashboards", "79-dashboard-finance"],
    ["/analytics/reports", "Report exports", "80-report-exports"],
    ["/analytics/forecast", "Demand forecast", "81-forecast"],
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
  // The sub-ledgers agree with the ledger before a period may be closed.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/finance/setup?view=close");
  await expect(page.getByRole("table", { name: "Sub-ledger reconciliation" })).toContainText("Receivables (open items)");
  await page.goto(`/finance/journals/new`);
  await expect(page.getByRole("heading", { level: 1, name: "New journal" })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  await shot(page, "82-journal-new-375");
  assertClean();
  for (const s of [state.maker, state.checker, state.viewer]) await s?.context.close();
});
