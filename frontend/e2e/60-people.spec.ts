import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect as baseExpect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { DEMO_PASSWORD, currentStep, expectNoHorizontalScroll, loadAdmin, shot, signIn, totp } from "./helpers";

/*
 * People: HR, payroll, expenses and employee self-service, end to end against the real API.
 * Setup data is created through the API by the people allowed to create it (no fixtures in the DB).
 * Salary components carry TEST TEMPLATE rates: they are test data, not statutory advice.
 *
 * Cast (all in DEMO01):
 *   admin      enables the modules, creates roles and users, grants access
 *   Anita      HR manager: employees, attendance, leave, structures; no salary access
 *   Vikram     payroll officer: salaries (MFA), payroll runs, posting
 *   Farah      finance head: approval limits, decides payroll / claims / advances; no salary access
 *   Kabir      accounts: pays claims and advances
 *   Priya      employee using self-service (existing DEMO user)
 */

test.describe.configure({ mode: "serial" });
// Several stacks share this machine during the run; API-backed screens can take a few seconds.
const expect = baseExpect.configure({ timeout: 15_000 });

const STATE = path.join(process.env.E2E_STATE_DIR ?? path.join(__dirname, ".state"), "people.json");
const TEMP = "Temp-People-Passw0rd-60!";
const PASSWORD = "People-Screens-Passphrase-2026";
const YEAR = 2026;

type Who = { email: string; name: string; password: string; secret?: string; lastStep: number };
type State = { users: Record<string, Who>; ids: Record<string, string> };

const CAST = {
  hr: { email: "anita.hr60@demo.local", name: "Anita Rao (E2E HR)" },
  payroll: { email: "vikram.payroll60@demo.local", name: "Vikram Shah (E2E Payroll)" },
  finance: { email: "farah.finance60@demo.local", name: "Farah Khan (E2E Finance)" },
  payer: { email: "kabir.accounts60@demo.local", name: "Kabir Mehta (E2E Accounts)" },
};
const PRIYA: Who = { email: "priya.requester@demo.local", name: "Priya Kulkarni (DEMO)", password: DEMO_PASSWORD, lastStep: 0 };

function load(): State {
  return JSON.parse(readFileSync(STATE, "utf8"));
}
function save(state: State) {
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}

// --- Helpers -------------------------------------------------------------------------------------

/**
 * Like helpers.watchConsole (fails on page errors and console errors), but also tolerates the
 * browser's network log for responses these screens expect and handle: 404 from /hr/my/profile/
 * for people without an employee record, and 409/422 refusals that the screen shows to the user.
 */
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    const url = m.location().url ?? "";
    if (/status of 40[13]|WebSocket connection/.test(text)) return;
    if (/status of 404/.test(text) && url.includes("/api/v1/hr/my/profile/")) return;
    if (/status of (409|422)/.test(text) && url.includes("/api/v1/")) return;
    errors.push(`${text} ${url}`);
  });
  return () => expect(errors, errors.join("\n")).toEqual([]);
}

/** Waits for an authenticator code from a time step this user hasn't used yet (replay protection). */
async function freshCode(page: Page, who: Who): Promise<string> {
  while (currentStep() <= who.lastStep) await page.waitForTimeout(1000);
  who.lastStep = currentStep();
  return totp(who.secret!);
}

type Reply = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Calls the API from inside the signed-in page (same cookies and CSRF header the app uses). */
async function call(page: Page, who: Who, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const once = () => page.evaluate(async ({ method, url, body, headers }) => {
    const csrf = document.cookie.split("; ").find((c) => c.startsWith("erp_csrf="));
    const h: Record<string, string> = { "Content-Type": "application/json", ...headers };
    if (csrf) h["X-CSRF-Token"] = decodeURIComponent(csrf.slice("erp_csrf=".length));
    const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }, { method, url, body, headers });
  let reply = await once();
  if (reply.status === 403 && reply.body?.type === "mfa_required" && who.secret) {
    const step = await call(page, who, "POST", "/api/v1/auth/step-up/", { code: await freshCode(page, who) });
    expect(step.status, JSON.stringify(step.body)).toBeLessThan(300);
    reply = await once();
  }
  return reply;
}

async function ok(page: Page, who: Who, method: string, url: string, body?: unknown, headers?: Record<string, string>) {
  const reply = await call(page, who, method, url, body, headers);
  expect(reply.status, `${method} ${url}: ${JSON.stringify(reply.body)}`).toBeLessThan(300);
  return reply.body;
}

/** Clicks through the step-up dialog if the server asks for a fresh verification, then waits for `done`. */
async function passStepUp(page: Page, who: Who, done: Locator) {
  const dialog = page.getByRole("dialog", { name: /Confirm it/ });
  await expect(dialog.or(done).first()).toBeVisible({ timeout: 20_000 });
  if (await dialog.isVisible()) {
    await dialog.getByLabel("Verification code").fill(await freshCode(page, who));
    await dialog.getByRole("button", { name: "Verify and continue" }).click();
  }
  await expect(done.first()).toBeVisible({ timeout: 20_000 });
}

async function login(page: Page, who: Who) {
  await signIn(page, who.email, who.password, who.secret, who.lastStep);
  if (who.secret) who.lastStep = Math.max(who.lastStep, currentStep());
}

async function session(browser: Browser, who: Who) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const clean = watchConsole(page);
  await login(page, who);
  return { page, clean, close: () => context.close() };
}

/** First sign-in of a user created by the admin: enrol MFA, store recovery codes, replace the password. */
async function firstLogin(browser: Browser, who: Who) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Work email").fill(who.email);
  await page.getByLabel("Password").fill(TEMP);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/setup\/mfa/);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const key = (await page.locator("p.select-all").innerText()).replace(/\s/g, "");
  who.secret = key;
  who.lastStep = currentStep();
  await page.getByLabel("Verification code").pressSequentially(totp(key));
  await page.getByRole("button", { name: "Turn on two-step verification" }).click();
  await page.getByLabel("I've stored these codes somewhere safe").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/setup\/password/);
  await page.getByLabel("Temporary password").fill(TEMP);
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repeat new password").fill(PASSWORD);
  await page.getByRole("button", { name: "Save password and continue" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  who.password = PASSWORD;
  await context.close();
}

async function mobile(page: Page, name: string, pathname: string, heading: string | RegExp) {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(pathname);
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expectNoHorizontalScroll(page);
  await shot(page, `${name}-375`);
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function pick(page: Page, trigger: Locator, option: string | RegExp) {
  await trigger.click();
  await page.getByRole("option", { name: option }).first().click();
}

async function pickEmployee(page: Page, trigger: Locator, search: string) {
  await trigger.click();
  await page.getByPlaceholder("Code or name").fill(search);
  await page.getByRole("option", { name: new RegExp(search) }).first().click();
}

function attendanceCsv(codes: string[], extra = ""): string {
  const rows = ["employee_code,date,status,check_in,check_out,remarks"];
  for (const code of codes) {
    for (let d = 1; d <= 31; d++) rows.push(`${code},${YEAR}-10-${String(d).padStart(2, "0")},present,09:00,17:30,`);
  }
  return rows.join("\n") + extra;
}

// --- 1. Setup ------------------------------------------------------------------------------------

test("setup: admin enables HR and expenses, creates roles and people", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const adminState = loadAdmin();
  const admin: Who = { email: "admin@demo.local", name: "System Administrator", password: adminState.password, secret: adminState.secret, lastStep: adminState.lastStep };
  const clean = watchConsole(page);
  await login(page, admin);

  // Modules ship disabled. Enabling is an audited admin action. NOTE: PATCH /admin/feature-flags/{id}/
  // currently answers 500 (backend bug, reported), so the isolated stack switches these two flags on
  // beforehand and only flags that are still off are patched here.
  const flags = await ok(page, admin, "GET", "/api/v1/admin/feature-flags/?page_size=200");
  for (const key of ["module.hr", "module.expenses"]) {
    const flag = (flags.results ?? flags).find((f: { key: string }) => f.key === key);
    if (!flag.enabled_default) await ok(page, admin, "PATCH", `/api/v1/admin/feature-flags/${flag.id}/`, { enabled_default: true });
  }

  // Ownership policies (templates) must be active; add one for employees cancelling their own leave.
  const policies = await ok(page, admin, "GET", "/api/v1/authorization/policies/?page_size=200");
  for (const code of ["allow_own_payslip", "allow_own_leave_request", "allow_own_expense_claim"]) {
    const p = policies.results.find((x: { code: string }) => x.code === code);
    if (!p.is_active) await ok(page, admin, "PATCH", `/api/v1/authorization/policies/${p.id}/`, { is_active: true, version: p.version });
  }
  if (!policies.results.some((x: { code: string }) => x.code === "allow_own_leave_cancel_e2e")) {
    await ok(page, admin, "POST", "/api/v1/authorization/policies/", {
      code: "allow_own_leave_cancel_e2e", effect: "allow", priority: 100, is_active: true,
      description: "E2E: employees can cancel their own leave requests (draft, rejected, or approved before it starts).",
      actions: ["hr.leave_request.cancel"], resource_types: ["hr.leave_request"],
      condition: { attr: "resource.employee_id", op: "eq", value: { attr: "subject.employee_id" } },
    });
  }

  const me = await ok(page, admin, "GET", "/api/v1/auth/me/");
  const company = me.active_company_id ?? me.companies[0].id;
  const roles: Record<string, { name: string; perms: string[]; mfa: boolean }> = {
    e2e_hr_manager: {
      name: "HR manager (E2E)", mfa: true,
      perms: ["hr.employee.create", "hr.employee.read", "hr.employee.update", "hr.attendance.create", "hr.attendance.read", "hr.attendance.update",
        "hr.leave_type.create", "hr.leave_type.read", "hr.leave_type.update", "hr.leave_balance.create", "hr.leave_balance.read", "hr.leave_balance.update",
        "hr.leave_request.create", "hr.leave_request.read", "hr.leave_request.update", "hr.leave_request.approve", "hr.leave_request.reject", "hr.leave_request.cancel",
        "hr.salary_structure.create", "hr.salary_structure.read", "hr.salary_structure.update", "hr.payslip.read", "hr.payroll_run.read", "organization.department.read"],
    },
    e2e_payroll_officer: {
      name: "Payroll officer (E2E)", mfa: true,
      perms: ["hr.salary.create", "hr.salary.read", "hr.salary.update", "hr.payroll_run.create", "hr.payroll_run.read", "hr.payroll_run.update", "hr.payroll_run.post",
        "hr.payslip.read", "hr.employee.read", "hr.salary_structure.read"],
    },
    e2e_finance_head: {
      name: "Finance head (E2E)", mfa: true,
      perms: ["authorization.approval_limit.read", "authorization.approval_limit.manage", "hr.payroll_run.read", "hr.payroll_run.approve", "hr.payroll_run.reject",
        "expenses.expense_claim.read", "expenses.expense_claim.approve", "expenses.expense_claim.reject", "expenses.employee_advance.read",
        "expenses.employee_advance.approve", "expenses.employee_advance.reject", "expenses.expense_category.create", "expenses.expense_category.read",
        "expenses.expense_category.update", "expenses.fuel_log.create", "expenses.fuel_log.read", "hr.employee.read"],
    },
    e2e_accounts_payer: {
      name: "Accounts payer (E2E)", mfa: true,
      perms: ["expenses.expense_claim.read", "expenses.expense_claim.pay", "expenses.employee_advance.read", "expenses.employee_advance.pay"],
    },
    e2e_employee: {
      name: "Employee self-service (E2E)", mfa: false,
      // The template's own-record permissions, plus reading leave types and expense categories, which
      // self-service needs to show names and pick categories (see report: API gap).
      perms: ["expenses.expense_claim.create", "expenses.employee_advance.create", "hr.leave_request.create", "hr.leave_type.read", "expenses.expense_category.read"],
    },
  };
  const roleIds: Record<string, string> = {};
  const existingRoles = await ok(page, admin, "GET", "/api/v1/authorization/roles/?page_size=200");
  for (const [code, r] of Object.entries(roles)) {
    const found = existingRoles.results.find((x: { code: string }) => x.code === code);
    roleIds[code] = found ? found.id : (await ok(page, admin, "POST", "/api/v1/authorization/roles/", {
      code, name: r.name, permission_codes: r.perms, mfa_required: r.mfa, description: "E2E people screens",
    })).id;
  }

  const state: State = { users: { priya: PRIYA }, ids: { company, ...Object.fromEntries(Object.entries(roleIds).map(([k, v]) => [`role:${k}`, v])) } };
  const users = await ok(page, admin, "GET", "/api/v1/identity/users/?page_size=200");
  const assign: [keyof typeof CAST | "priya", string][] = [["hr", "e2e_hr_manager"], ["hr", "e2e_employee"], ["payroll", "e2e_payroll_officer"],
    ["finance", "e2e_finance_head"], ["payer", "e2e_accounts_payer"], ["priya", "e2e_employee"]];
  for (const [key, c] of Object.entries(CAST)) {
    const existing = users.results.find((u: { email: string }) => u.email === c.email);
    const user = existing ?? await ok(page, admin, "POST", "/api/v1/identity/users/",
      { email: c.email, full_name: c.name, default_company: company, mfa_enforced: true, temporary_password: TEMP }, { "Idempotency-Key": crypto.randomUUID() });
    state.users[key] = { email: c.email, name: c.name, password: TEMP, lastStep: 0 };
    state.ids[`user:${key}`] = user.id;
  }
  state.ids["user:priya"] = users.results.find((u: { email: string }) => u.email === PRIYA.email).id;
  for (const [key, role] of assign) {
    // Approval limits are organization-wide records, so whoever manages them needs an organization grant.
    const org = role === "e2e_finance_head";
    await ok(page, admin, "POST", "/api/v1/authorization/role-assignments/", {
      user: state.ids[`user:${key}`], role: roleIds[role], scope_type: org ? "organization" : "company", scope_id: org ? me.user.organization_id : company,
      reason: "E2E people screens",
    });
  }
  clean();

  // Each new person signs in once: two-step verification, recovery codes, own password.
  for (const key of Object.keys(CAST)) await firstLogin(browser, state.users[key]);
  save(state);
});

// --- 2. HR set-up through the screens ---------------------------------------------------------

test("HR manager adds an employee, leave type and balances; salary set-up data is editable", async ({ browser }) => {
  test.setTimeout(240_000);
  const state = load();
  const hr = state.users.hr;
  const { page, clean, close } = await session(browser, hr);

  await page.goto("/hr/employees");
  await expect(page.getByRole("heading", { level: 1, name: "Employees" })).toBeVisible();
  await page.getByRole("button", { name: "Add employee" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Employee code").fill("E60-001");
  await dialog.getByLabel("Full name").fill("Priya Kulkarni (DEMO)");
  await pick(page, dialog.getByLabel("Department"), "Production (DEMO)");
  await dialog.getByLabel("Date of joining").fill(`${YEAR}-04-01`);
  await dialog.getByLabel("Designation").fill("Planning engineer");
  await dialog.getByRole("combobox", { name: /Sign-in account|No account linked/ }).click();
  await page.getByPlaceholder("Type a name or email").fill("priya");
  await page.getByRole("option", { name: /Priya Kulkarni/ }).click();
  await dialog.getByLabel("Bank IFSC").fill("HDFC0001234");
  await dialog.getByLabel("Bank account number").fill("001234567890");
  await dialog.getByLabel("PAN", { exact: true }).fill("ABCDE1234F");
  await dialog.getByLabel("Aadhaar, last 4 digits").fill("4321");
  await shot(page, "60-employee-new");
  await dialog.getByRole("button", { name: "Add employee" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Priya Kulkarni (DEMO)" })).toBeVisible();
  // Only masked hints come back; the full numbers never render.
  await expect(page.getByText("XXXX7890").first()).toBeVisible();
  await expect(page.getByText("XXXX-XXXX-XX21").first()).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("001234567890");
  expect(body).not.toContain("ABCDE1234F");
  await shot(page, "60-employee-detail");
  state.ids["employee:priya"] = page.url().split("/").pop()!;

  // The HR manager's own employee record (they also use self-service) and the department id.
  const depts = await ok(page, hr, "GET", "/api/v1/organization/departments/?search=PROD");
  const dept = depts.results.find((d: { code: string }) => d.code === "PROD").id;
  const own = await ok(page, hr, "POST", "/api/v1/hr/employees/", {
    code: "E60-002", full_name: hr.name, department: dept, user: state.ids["user:hr"], date_of_joining: `${YEAR}-04-01`, designation: "HR manager",
  });
  state.ids["employee:hr"] = own.id;

  // Leave type through the screen; balances through the screen (Priya) and the API (Anita).
  await page.goto("/hr/leave?tab=types");
  await page.getByRole("button", { name: "Leave type" }).click();
  await page.getByRole("dialog").getByLabel("Code").fill("CL60");
  await page.getByRole("dialog").getByLabel("Name").fill("Casual leave (E2E)");
  await page.getByRole("dialog").getByLabel("Days a year").fill("12");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("row", { name: /Casual leave \(E2E\)/ })).toBeVisible();
  const types = await ok(page, hr, "GET", "/api/v1/hr/leave-types/?search=CL60");
  state.ids["leave:CL60"] = types.results[0].id;

  await page.goto("/hr/leave?tab=balances");
  await page.getByRole("button", { name: "Allocate" }).click();
  const alloc = page.getByRole("dialog");
  await pickEmployee(page, alloc.getByRole("combobox", { name: "Employee" }), "E60-001");
  await pick(page, alloc.getByLabel("Leave type"), /Casual leave \(E2E\)/);
  await alloc.getByRole("button", { name: "Allocate" }).click();
  await expect(page.getByRole("row", { name: /E60-001.*Casual leave \(E2E\)/ })).toContainText("12");
  await ok(page, hr, "POST", "/api/v1/hr/leave-balances/", { employee: own.id, leave_type: state.ids["leave:CL60"], year: YEAR });
  await shot(page, "60-leave-balances");

  // Salary components: statutory rates and ceilings are data. TEST TEMPLATE values, labelled as such.
  const component = (body: Record<string, unknown>) => ok(page, hr, "POST", "/api/v1/hr/salary-components/", { company: state.ids.company, ...body });
  await component({ code: "BASIC60", name: "Basic pay", kind: "earning", calculation: "fixed", is_basic: true, sequence: 10 });
  await component({ code: "HRA60", name: "House rent allowance (TEST TEMPLATE 40%)", kind: "earning", calculation: "percent_of_basic", rate_pct: "40", sequence: 20 });
  await component({ code: "PF60", name: "Provident fund, employee (TEST TEMPLATE rate)", kind: "deduction", calculation: "percent_of_basic", rate_pct: "12", wage_ceiling: "15000", is_statutory: true, sequence: 50 });
  await component({ code: "PFER60", name: "Provident fund, employer (TEST TEMPLATE rate)", kind: "employer_contribution", calculation: "percent_of_basic", rate_pct: "12", wage_ceiling: "15000", is_statutory: true, sequence: 60 });

  // A professional-tax slab through the screen, then its slab limit edited (rates are editable data).
  await page.goto("/hr/payroll?tab=components");
  await page.getByRole("button", { name: "Component" }).click();
  const comp = page.getByRole("dialog");
  await comp.getByLabel("Code").fill("PT60");
  await comp.getByLabel("Name").fill("Professional tax (TEST TEMPLATE slab)");
  await pick(page, comp.getByLabel("Kind"), "Deduction");
  await comp.getByLabel("Applies from gross").fill("10000");
  await comp.getByLabel("Order").fill("70");
  await comp.getByLabel("Statutory").click();
  await comp.getByLabel("Scale with paid days").click();
  await shot(page, "60-component-new");
  await comp.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("row", { name: /Professional tax/ })).toBeVisible();
  await page.getByRole("button", { name: "Edit PT60" }).click();
  await page.getByRole("dialog").getByLabel("Applies from gross").fill("15000");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("row", { name: /Professional tax/ })).toContainText("15000");
  await shot(page, "60-components");

  // Structure through the screen.
  await page.goto("/hr/payroll?tab=structures");
  await page.getByRole("button", { name: "Structure" }).click();
  const st = page.getByRole("dialog");
  await st.getByLabel("Code").fill("STD60");
  await st.getByLabel("Name").fill("Staff (E2E)");
  for (const code of ["BASIC60", "HRA60", "PF60", "PFER60", "PT60"]) await st.getByRole("checkbox", { name: `Include ${code}` }).click();
  await st.getByLabel("PT60 monthly amount").fill("200");
  await st.getByRole("button", { name: "Add structure" }).click();
  await expect(page.getByRole("row", { name: /Staff \(E2E\)/ })).toContainText("BASIC60");

  // Attendance import: a bad file is refused as a whole, with row errors; the fixed file imports.
  await page.goto(`/hr/attendance?period=${YEAR}-10`);
  await page.getByRole("button", { name: "Import CSV" }).click();
  const imp = page.getByRole("dialog");
  await imp.getByLabel("Rows").fill(attendanceCsv(["E60-001", "E60-002"], `\nE60-999,${YEAR}-10-05,present,,,\nE60-001,${YEAR}-10-32,present,,,`));
  await imp.getByRole("button", { name: "Import" }).click();
  await expect(imp.getByText(/row\(s\) have errors; nothing was imported/)).toBeVisible();
  await expect(imp.getByRole("cell", { name: "Unknown employee code." })).toBeVisible();
  await expect(imp.getByRole("cell", { name: "Use YYYY-MM-DD." })).toBeVisible();
  await shot(page, "60-attendance-import-errors");
  await imp.getByLabel("Rows").fill(attendanceCsv(["E60-001", "E60-002"]));
  await imp.getByRole("button", { name: "Import" }).click();
  await expect(imp).toBeHidden({ timeout: 60_000 });
  await expect(page.getByText(/Imported 62 row/)).toBeVisible();
  await expect(page.getByRole("row", { name: /E60-001/ }).first()).toContainText("Present");
  await shot(page, "60-attendance");

  for (const [name, url, heading] of [["60-employees", "/hr/employees", "Employees"], ["60-attendance", `/hr/attendance?period=${YEAR}-10`, "Attendance"],
    ["60-leave-types", "/hr/leave?tab=types", "Leave"], ["60-payroll-components", "/hr/payroll?tab=components", "Payroll"]] as const) {
    await mobile(page, name, url, heading);
  }
  save(state);
  clean();
  await close();
});

// --- 3. Leave: self-service request, manager decision, self-approval refused ----------------------

test("employee applies for leave in self-service; the manager approves; nobody approves their own", async ({ browser }) => {
  test.setTimeout(180_000);
  const state = load();
  const priya = await session(browser, state.users.priya);
  await priya.page.goto("/me/leave");
  await expect(priya.page.getByRole("heading", { level: 1, name: "My leave" })).toBeVisible();
  await expect(priya.page.getByText("Casual leave (E2E)").first()).toBeVisible();
  const apply = async (from: string, to: string, reason: string) => {
    await pick(priya.page, priya.page.getByLabel("Leave type"), "Casual leave (E2E)");
    await priya.page.getByLabel("From", { exact: true }).fill(from);
    await priya.page.getByLabel("To", { exact: true }).fill(to);
    await priya.page.getByLabel("Reason").fill(reason);
    await priya.page.getByRole("button", { name: "Request leave" }).click();
    await expect(priya.page.getByText("Leave requested.")).toBeVisible();
  };
  await apply(`${YEAR}-11-16`, `${YEAR}-11-17`, "Family function");
  await apply(`${YEAR}-12-21`, `${YEAR}-12-21`, "Personal errand");
  await expect(priya.page.getByRole("listitem").filter({ hasText: "Family function" })).toContainText("Submitted");
  await shot(priya.page, "61-my-leave");
  await mobile(priya.page, "61-my-leave", "/me/leave", "My leave");

  // The HR manager applies for their own leave too, then finds they can't decide it.
  const hr = await session(browser, state.users.hr);
  await hr.page.goto("/me/leave");
  await pick(hr.page, hr.page.getByLabel("Leave type"), "Casual leave (E2E)");
  await hr.page.getByLabel("From", { exact: true }).fill(`${YEAR}-11-23`);
  await hr.page.getByLabel("To", { exact: true }).fill(`${YEAR}-11-23`);
  await hr.page.getByRole("button", { name: "Request leave" }).click();
  await expect(hr.page.getByText("Leave requested.")).toBeVisible();

  await hr.page.goto("/hr/leave");
  const ownRow = hr.page.getByRole("row", { name: new RegExp(state.users.hr.name.replace(/[()]/g, "\\$&")) });
  await ownRow.getByRole("button", { name: "Decide" }).click();
  await expect(hr.page.getByRole("dialog")).toContainText("This is your own leave request. Someone else must decide it.");
  await expect(hr.page.getByRole("dialog").getByRole("button", { name: "Approve" })).toHaveCount(0);
  await shot(hr.page, "61-own-leave-blocked");
  await hr.page.keyboard.press("Escape");
  // The server refuses it too, whatever the screen shows.
  const mine = await ok(hr.page, state.users.hr, "GET", `/api/v1/hr/leave-requests/?employee=${state.ids["employee:hr"]}&status=submitted`);
  const refused = await call(hr.page, state.users.hr, "POST", `/api/v1/hr/leave-requests/${mine.results[0].id}/decide/`, { approve: true, version: mine.results[0].version });
  expect(refused.status).toBe(403);

  // Priya's first request: approved. Her second: rejected with a reason.
  const priyaRow = (text: string) => hr.page.getByRole("row", { name: /Priya Kulkarni/ }).filter({ hasText: text });
  await priyaRow("16 Nov").getByRole("button", { name: "Decide" }).click();
  await shot(hr.page, "61-leave-decide");
  await hr.page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(hr.page.getByText("Leave approved")).toBeVisible();
  await priyaRow("21 Dec").getByRole("button", { name: "Decide" }).click();
  await hr.page.getByRole("dialog").getByLabel("Comment").fill("Year-end freeze; please pick January.");
  await hr.page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
  await expect(hr.page.getByText("Leave rejected")).toBeVisible();
  await hr.page.goto("/hr/leave?status=any");
  await expect(priyaRow("16 Nov")).toContainText("Approved");
  await shot(hr.page, "61-leave-requests");
  await mobile(hr.page, "61-leave-requests", "/hr/leave?status=any", "Leave");
  hr.clean();
  await hr.close();

  // Priya sees the outcomes, her balance drops by 2, and she cancels the rejected request.
  await priya.page.goto("/me/leave");
  await expect(priya.page.getByRole("listitem").filter({ hasText: "Family function" })).toContainText("Approved");
  await expect(priya.page.getByRole("listitem").filter({ hasText: "Casual leave (E2E)" }).filter({ hasText: "of 12" })).toContainText("10");
  const rejected = priya.page.getByRole("listitem").filter({ hasText: "Personal errand" });
  await expect(rejected).toContainText("Rejected");
  await rejected.getByRole("button", { name: "Cancel leave" }).click();
  await priya.page.getByRole("dialog").getByRole("button", { name: "Cancel leave" }).click();
  await expect(rejected).toContainText("Cancelled");
  await shot(priya.page, "61-my-leave-after");
  priya.clean();
  await priya.close();
});

// --- 4. Payroll: compute -> submit -> decide by another user -> post ------------------------------

test("payroll: salaries behind step-up, run computed and submitted, approved by someone else, posted", async ({ browser }) => {
  test.setTimeout(420_000);
  const state = load();
  const officer = state.users.payroll;

  // Finance head sets approval limits for their role first (they own financial controls).
  const finance = await session(browser, state.users.finance);
  for (const document_type of ["hr.payroll_run", "expenses.expense_claim", "expenses.employee_advance"]) {
    await ok(finance.page, state.users.finance, "POST", "/api/v1/authorization/approval-limits/", {
      role: state.ids["role:e2e_finance_head"], document_type, currency: "INR", max_amount: "1000000",
    });
  }

  const p = await session(browser, officer);
  const signedInAt = Date.now();
  // Salary amounts need a verification within the last minute on this stack; wait it out so the
  // step-up dialog has to appear, as it would for someone who signed in a while ago.
  await p.page.goto("/hr/payroll?tab=components");
  await expect(p.page.getByRole("row", { name: /Professional tax/ })).toBeVisible();
  await p.page.waitForTimeout(Math.max(0, 62_000 - (Date.now() - signedInAt)));
  await p.page.goto("/hr/payroll?tab=salaries");
  const stepUp = p.page.getByRole("dialog", { name: /Confirm it/ });
  await expect(stepUp).toBeVisible();
  await shot(p.page, "62-salary-step-up");
  await stepUp.getByLabel("Verification code").fill(await freshCode(p.page, officer));
  await stepUp.getByRole("button", { name: "Verify and continue" }).click();
  await expect(p.page.getByText("No salaries assigned")).toBeVisible();

  for (const [code, basic] of [["E60-001", "30000"], ["E60-002", "50000"]] as const) {
    await p.page.getByRole("button", { name: "Assign salary" }).click();
    const d = p.page.getByRole("dialog");
    await pickEmployee(p.page, d.getByRole("combobox", { name: "Employee" }), code);
    await pick(p.page, d.getByLabel("Structure"), "Staff (E2E)");
    await d.getByLabel("Effective from").fill(`${YEAR}-04-01`);
    await d.getByLabel(/Basic pay/).fill(basic);
    await d.getByRole("button", { name: "Assign salary" }).click();
    await passStepUp(p.page, officer, p.page.getByRole("row", { name: new RegExp(code) }));
  }
  await expect(p.page.getByRole("row", { name: /E60-001/ })).toContainText("₹30,000.00");
  await shot(p.page, "62-salaries");

  // Run: create, compute, submit.
  await p.page.goto("/hr/payroll");
  await p.page.getByRole("button", { name: "New payroll run" }).click();
  await pick(p.page, p.page.getByRole("dialog").getByLabel("Month"), "October");
  await p.page.getByRole("dialog").getByLabel("Year").fill(String(YEAR));
  await p.page.getByRole("dialog").getByRole("button", { name: "Create run" }).click();
  await expect(p.page.getByRole("heading", { level: 1, name: `Payroll October ${YEAR}` })).toBeVisible();
  const runId = p.page.url().split("/").pop()!;
  state.ids.run = runId;
  await p.page.getByRole("button", { name: "Compute" }).click();
  await expect(p.page.getByText("Computed 2 payslip(s)")).toBeVisible();
  // Priya: basic 30,000 + HRA 12,000 = 42,000 gross; PF 12% of the 15,000 ceiling = 1,800; PT 200.
  await expect(p.page.getByText("₹1,12,000.00")).toBeVisible(); // gross total
  await expect(p.page.getByText("₹1,08,000.00")).toBeVisible(); // net total
  await expect(p.page.getByRole("row", { name: /Priya Kulkarni/ })).toContainText("₹40,000.00");
  await shot(p.page, "62-run-computed");
  await p.page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(p.page.getByText("Sent for approval")).toBeVisible();
  // The officer can't approve: no decision action for them.
  await expect(p.page.getByRole("button", { name: "Decide" })).toHaveCount(0);
  await mobile(p.page, "62-run-submitted", `/hr/payroll-runs/${runId}`, `Payroll October ${YEAR}`);

  // Farah approves. She can't read salaries, so the totals show as Restricted, not zero.
  await finance.page.goto(`/hr/payroll-runs/${runId}`);
  await expect(finance.page.getByRole("heading", { level: 1, name: `Payroll October ${YEAR}` })).toBeVisible();
  await expect(finance.page.getByText("Restricted").first()).toBeVisible();
  expect(await finance.page.getByText("Restricted").count()).toBeGreaterThanOrEqual(5);
  await expect(finance.page.getByText("₹0.00")).toHaveCount(0);
  await shot(finance.page, "62-run-restricted-approver");
  await finance.page.getByRole("button", { name: "Decide" }).click();
  await finance.page.getByRole("dialog").getByLabel("Comment").fill("Checked headcount and attendance.");
  await finance.page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await passStepUp(finance.page, state.users.finance, finance.page.getByText("Payroll approved"));
  await expect(finance.page.getByText("Approved", { exact: true }).first()).toBeVisible();
  finance.clean();
  await finance.close();

  // Vikram posts it (Idempotency-Key sent by the screen).
  await p.page.goto(`/hr/payroll-runs/${runId}`);
  await p.page.getByRole("button", { name: "Post to ledger" }).click();
  await p.page.getByRole("dialog").getByRole("button", { name: "Post payroll" }).click();
  await passStepUp(p.page, officer, p.page.getByText(/posted to the ledger/));
  await expect(p.page.getByText("Posted", { exact: true }).first()).toBeVisible();
  await shot(p.page, "62-run-posted");
  save(state);
  p.clean();
  await p.close();
});

test("payslips: employee sees only their own; HR without salary access sees amounts as restricted", async ({ browser }) => {
  test.setTimeout(150_000);
  const state = load();
  const priya = await session(browser, state.users.priya);
  await priya.page.goto("/me/payslips");
  await expect(priya.page.getByRole("heading", { level: 1, name: "My payslips" })).toBeVisible();
  await expect(priya.page.getByRole("button", { name: new RegExp(`October ${YEAR}`) })).toHaveCount(1);
  await expect(priya.page.getByText("₹40,000.00")).toBeVisible();
  await expect(priya.page.getByText("₹68,000.00")).toHaveCount(0); // the HR manager's net pay
  await priya.page.getByRole("button", { name: new RegExp(`October ${YEAR}`) }).click();
  await expect(priya.page.getByText("Provident fund, employee (TEST TEMPLATE rate)")).toBeVisible();
  await expect(priya.page.getByText("₹42,000.00")).toBeVisible();
  await shot(priya.page, "63-my-payslips");
  // The API only ever returns her own payslips.
  const own = await ok(priya.page, state.users.priya, "GET", "/api/v1/hr/my/payslips/");
  expect(own.map((s: { employee_code: string }) => s.employee_code)).toEqual(["E60-001"]);
  await mobile(priya.page, "63-my-payslips", "/me/payslips", "My payslips");
  priya.clean();
  await priya.close();

  const hr = await session(browser, state.users.hr);
  await hr.page.goto(`/hr/payroll?tab=payslips&run=${state.ids.run}`);
  await expect(hr.page.getByRole("row", { name: /Priya Kulkarni/ })).toContainText("Restricted");
  await expect(hr.page.getByText("₹40,000.00")).toHaveCount(0);
  await hr.page.getByRole("button", { name: /Priya Kulkarni/ }).click();
  await expect(hr.page.getByRole("dialog")).toContainText("Pay lines are restricted");
  await shot(hr.page, "63-payslips-restricted");
  await hr.page.keyboard.press("Escape");
  await hr.page.goto("/hr/payroll");
  await expect(hr.page.getByRole("row", { name: new RegExp(`October ${YEAR}`) })).toContainText("Restricted");
  await mobile(hr.page, "63-payroll-runs-restricted", "/hr/payroll", "Payroll");
  // The HR manager sees their own payslip with amounts in self-service.
  await hr.page.goto("/me/payslips");
  await expect(hr.page.getByText("₹68,000.00")).toBeVisible();
  hr.clean();
  await hr.close();
});

// --- 5. Expenses: claim filed by the employee, approved and paid by two other people ------------

test("expense claim: employee files and submits; finance approves; accounts pays; advance and fuel", async ({ browser }) => {
  test.setTimeout(300_000);
  const state = load();
  const finance = await session(browser, state.users.finance);
  await finance.page.goto("/expenses?tab=categories");
  await finance.page.getByRole("button", { name: "Category" }).click();
  const cat = finance.page.getByRole("dialog");
  await cat.getByLabel("Code").fill("TRV60");
  await cat.getByLabel("Name").fill("Local travel (E2E)");
  await cat.getByLabel("Per-claim limit (₹)").fill("10000");
  await cat.getByLabel("Receipt needed above (₹)").fill("500");
  await cat.getByRole("button", { name: "Save" }).click();
  await expect(finance.page.getByRole("row", { name: /Local travel \(E2E\)/ })).toContainText("₹10,000.00");
  await ok(finance.page, state.users.finance, "POST", "/api/v1/expenses/categories/", { company: state.ids.company, code: "MEAL60", name: "Meals (E2E)", per_claim_limit: "2000" });
  await shot(finance.page, "64-categories");

  // Priya files a claim on her phone-sized screen.
  const priya = await session(browser, state.users.priya);
  await priya.page.setViewportSize({ width: 375, height: 812 });
  await priya.page.goto("/me/expenses/new");
  await expect(priya.page.getByRole("heading", { level: 1, name: "New expense claim" })).toBeVisible();
  await priya.page.getByLabel("Purpose").fill("Supplier visit, Chakan (E2E)");
  await pick(priya.page, priya.page.getByLabel("Category").first(), "Local travel (E2E)");
  await priya.page.getByLabel("What for").first().fill("Cab to supplier and back");
  await priya.page.getByLabel("Amount (₹)").first().fill("1200");
  await expect(priya.page.getByText("Above ₹500.00 needs a receipt.")).toBeVisible();
  await priya.page.getByRole("button", { name: "Add another expense" }).click();
  await pick(priya.page, priya.page.getByLabel("Category").nth(1), "Meals (E2E)");
  await priya.page.getByLabel("What for").nth(1).fill("Lunch with supplier team");
  await priya.page.getByLabel("Amount (₹)").nth(1).fill("450.50");
  await expect(priya.page.getByText("₹1,650.50")).toBeVisible();
  await expectNoHorizontalScroll(priya.page);
  await shot(priya.page, "64-new-claim-375");
  await priya.page.getByRole("button", { name: "Submit claim" }).click();
  // Saved as a draft but refused on submit: the policy (receipt threshold) is data on the category.
  await expect(priya.page.getByText(/not submitted/)).toBeVisible();
  await expect(priya.page.getByRole("heading", { level: 1, name: "Expense claim" })).toBeVisible();
  await priya.page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(priya.page.getByRole("cell", { name: /needs a receipt/ })).toBeVisible();
  await shot(priya.page, "64-claim-policy-errors-375");
  await priya.page.getByRole("button", { name: "Edit" }).click();
  await priya.page.getByLabel("Receipt").first().fill("UBER-60-0001");
  await priya.page.getByRole("button", { name: "Save claim" }).click();
  await expect(priya.page.getByText("Claim saved")).toBeVisible();
  await priya.page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(priya.page.getByText("Waiting for approval.")).toBeVisible();
  const claimId = priya.page.url().split("/").pop()!;
  await shot(priya.page, "64-claim-submitted-375");

  // Advance request from self-service.
  await priya.page.goto("/me/expenses");
  await priya.page.getByRole("button", { name: "Request an advance" }).click();
  await priya.page.getByRole("dialog").getByLabel("Amount (₹)").fill("5000");
  await priya.page.getByRole("dialog").getByLabel("Purpose").fill("Trade fair travel, Mumbai (E2E)");
  await priya.page.getByRole("dialog").getByRole("button", { name: "Request advance" }).click();
  await expect(priya.page.getByRole("dialog")).toContainText("Advance requested");
  await priya.page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await expect(priya.page.getByRole("link", { name: /Supplier visit, Chakan/ })).toContainText("Submitted");
  await expectNoHorizontalScroll(priya.page);
  await shot(priya.page, "64-my-expenses-375");

  // Farah decides the claim (she isn't the claimant) and the advance.
  await finance.page.goto("/expenses");
  await finance.page.getByRole("link", { name: /Priya Kulkarni/ }).first().click();
  await expect(finance.page.getByRole("heading", { level: 1, name: /Supplier visit, Chakan/ })).toBeVisible();
  await expect(finance.page.getByRole("cell", { name: "UBER-60-0001" })).toBeVisible();
  await finance.page.getByRole("button", { name: "Decide" }).click();
  await finance.page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(finance.page.getByText(/approved and posted/)).toBeVisible();
  await shot(finance.page, "64-claim-approved");
  await finance.page.goto("/expenses?tab=advances");
  await finance.page.getByRole("link", { name: /Priya Kulkarni/ }).first().click();
  await finance.page.getByRole("button", { name: "Decide" }).click();
  await finance.page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(finance.page.getByText(/Advance .* approved/)).toBeVisible();

  // Fuel log: odometer must keep rising per vehicle.
  await finance.page.goto("/expenses?tab=fuel");
  const fuel = async (odometer: string) => {
    await finance.page.getByRole("button", { name: "Fuel log" }).click();
    const d = finance.page.getByRole("dialog");
    await d.getByLabel("Vehicle registration").fill("MH12AB6060");
    await d.getByLabel("Date").fill(`${YEAR}-10-30`);
    await d.getByLabel("Odometer (km)").fill(odometer);
    await d.getByLabel("Litres").fill("20");
    await d.getByLabel("Rate per litre (₹)").fill("104.50");
    await pickEmployee(finance.page, d.getByRole("combobox", { name: "Driver" }), "E60-001");
    return d;
  };
  let d = await fuel("10500");
  await d.getByRole("button", { name: "Record" }).click();
  await expect(finance.page.getByRole("row", { name: /MH12AB6060/ })).toContainText("10500 km");
  d = await fuel("10400");
  await expect(d.getByText(/Must be above the last reading \(10500 km/)).toBeVisible();
  await expect(d.getByRole("button", { name: "Record" })).toBeDisabled();
  await shot(finance.page, "64-fuel-odometer");
  await finance.page.keyboard.press("Escape");
  await mobile(finance.page, "64-expenses-claims", "/expenses?status=any", "Expense claims");
  finance.clean();
  await finance.close();

  // Kabir pays both; the claimant can't be the payer (guarded by the server; the screen says so).
  const payer = await session(browser, state.users.payer);
  await payer.page.goto(`/expenses/claims/${claimId}`);
  await payer.page.getByRole("button", { name: "Record payment" }).click();
  await payer.page.getByRole("dialog").getByLabel("Bank reference").fill("NEFT-60-0001");
  await payer.page.getByRole("dialog").getByRole("button", { name: "Record payment" }).click();
  await passStepUp(payer.page, state.users.payer, payer.page.getByText(/marked paid/));
  await expect(payer.page.getByText("NEFT-60-0001")).toBeVisible();
  await expect(payer.page.getByText("Paid", { exact: true }).first()).toBeVisible();
  await shot(payer.page, "64-claim-paid");
  await payer.page.goto("/expenses?tab=advances&status=approved");
  await payer.page.getByRole("link", { name: /Priya Kulkarni/ }).first().click();
  await payer.page.getByRole("button", { name: "Record payment" }).click();
  await payer.page.getByRole("dialog").getByLabel("Bank reference").fill("NEFT-60-0002");
  await payer.page.getByRole("dialog").getByRole("button", { name: "Record payment" }).click();
  await passStepUp(payer.page, state.users.payer, payer.page.getByText(/Advance .* paid/));
  payer.clean();
  await payer.close();

  // Priya sees the claim paid.
  await priya.page.goto(`/me/expenses/${claimId}`);
  await expect(priya.page.getByText("Paid to your bank account.")).toBeVisible();
  await expect(priya.page.getByText("NEFT-60-0001")).toBeVisible();
  await expectNoHorizontalScroll(priya.page);
  await shot(priya.page, "64-my-claim-paid-375");
  priya.clean();
  await priya.close();
});
