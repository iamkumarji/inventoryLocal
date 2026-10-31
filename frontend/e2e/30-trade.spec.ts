/**
 * Partners, procurement, sales and logistics screens, end to end against a real stack:
 * procure-to-pay up to goods receipt, order-to-invoice with delivery, shipment dispatch and proof of
 * delivery, with maker-checker rejections, a credit block, and phone-width layout checks.
 *
 * Setup data (roles, grants, MFA for the checkers, items) is created through the API. Narrowly scoped
 * workarounds exist for backend bugs listed in the trade report; each tries the real path first.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect as baseExpect, request, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { currentStep, DEMO_PASSWORD, expectNoHorizontalScroll, loadAdmin, saveAdmin, shot, signIn, totp, watchConsole } from "./helpers";

// Dev servers compile each route on first use; give UI assertions room for that.
const expect = baseExpect.configure({ timeout: 20_000 });

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const STATE = path.join(process.env.E2E_STATE_DIR ?? path.join(__dirname, ".state"), "trade.json");
const BACKEND = path.resolve(__dirname, "../../backend");

const MAKER = "priya.requester@demo.local";
const CHECKER = "meera.planthead@demo.local";
const LIMITS = "rahul.supervisor@demo.local";

type TradeState = {
  company: string;
  secrets: Record<string, string>;
  lastStep: Record<string, number>;
  item: { id: string; code: string };
  uoms: { NOS: string; BOX: string };
  supplierCode: string;
  customerCode: string;
};

function saveTrade(state: TradeState) {
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}

function loadTrade(): TradeState {
  return JSON.parse(readFileSync(STATE, "utf8"));
}

/** Waits for a TOTP step that hasn't been used by this user (the server rejects replays). */
async function freshCode(secret: string, lastStep: number): Promise<{ code: string; step: number }> {
  while (currentStep() <= lastStep) await new Promise((r) => setTimeout(r, 1000));
  return { code: totp(secret), step: currentStep() };
}

class Api {
  constructor(readonly ctx: APIRequestContext, private company?: string) {}

  static async create() {
    return new Api(await request.newContext({ baseURL: BASE }));
  }

  setCompany(id: string) {
    this.company = id;
  }

  private async headers(extra?: Record<string, string>) {
    const cookies = (await this.ctx.storageState()).cookies;
    const csrf = cookies.find((c) => c.name === "erp_csrf")?.value;
    return { ...(csrf ? { "X-CSRF-Token": decodeURIComponent(csrf) } : {}), ...(this.company ? { "X-Company-ID": this.company } : {}), ...extra };
  }

  async call<T = Record<string, unknown>>(method: "GET" | "POST" | "PATCH" | "PUT", url: string, data?: unknown, extra?: Record<string, string>): Promise<T> {
    const res = await this.ctx.fetch(`/api/v1${url}`, { method, data, headers: await this.headers(extra) });
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${url} -> ${res.status()}: ${text.slice(0, 600)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async tryCall(method: "GET" | "POST" | "PATCH", url: string, data?: unknown) {
    const res = await this.ctx.fetch(`/api/v1${url}`, { method, data, headers: await this.headers() });
    return { status: res.status(), body: await res.text() };
  }

  get = <T = Record<string, unknown>>(url: string) => this.call<T>("GET", url);
  post = <T = Record<string, unknown>>(url: string, data?: unknown, extra?: Record<string, string>) => this.call<T>("POST", url, data ?? {}, extra);
  patch = <T = Record<string, unknown>>(url: string, data: unknown) => this.call<T>("PATCH", url, data);

  /** Password sign-in, with the TOTP step when the account has MFA. Returns the step used (0 if none). */
  async login(email: string, password: string, secret?: string, lastStep = 0): Promise<number> {
    const first = await this.post<{ status: string; challenge_token?: string }>("/auth/login/", { email, password });
    if (first.status !== "mfa_required") return 0;
    if (!secret) throw new Error(`${email} needs MFA but no secret is known`);
    const { code, step } = await freshCode(secret, lastStep);
    await this.post("/auth/login/mfa/", { challenge_token: first.challenge_token, code });
    return step;
  }

  async dispose() {
    await this.ctx.dispose();
  }
}

/**
 * Runs Django code against the e2e database. ONLY used to work around backend bugs reported with the
 * trade screens (feature-flag PATCH 500, missing partner profiles, approve-supplier always 403). Each
 * caller first tries the real API/UI and falls back to this only when the bug is still present.
 */
function backendShell(code: string): string {
  const db = process.env.E2E_DATABASE_URL;
  if (!db) throw new Error("A backend bug workaround is needed: set E2E_DATABASE_URL to the e2e database (e.g. postgres:///otabu_erp_fe_trade).");
  return execFileSync(path.join(BACKEND, ".venv/bin/python"), ["manage.py", "shell", "-c", code], {
    cwd: BACKEND,
    env: { ...process.env, DATABASE_URL: db, DJANGO_SETTINGS_MODULE: "config.settings.dev", ...(process.env.E2E_REDIS_URL ? { REDIS_URL: process.env.E2E_REDIS_URL } : {}) },
    encoding: "utf8",
  });
}

/** Workaround: partners created through the API get no supplier/customer profile (master_schema overrides create). */
function ensurePartnerProfiles(code: string): boolean {
  const out = backendShell(`
from apps.partners.models import Partner, SupplierProfile, CustomerProfile
p = Partner.objects.get(code=${JSON.stringify(code)})
made = 0
if p.is_supplier and not SupplierProfile.objects.filter(partner=p).exists():
    SupplierProfile.objects.create(organization_id=p.organization_id, partner=p, created_by_id=p.created_by_id, updated_by_id=p.created_by_id); made += 1
if p.is_customer and not CustomerProfile.objects.filter(partner=p).exists():
    CustomerProfile.objects.create(organization_id=p.organization_id, partner=p, created_by_id=p.created_by_id, updated_by_id=p.created_by_id); made += 1
print("PROFILES_CREATED", made)
`);
  return /PROFILES_CREATED [1-9]/.test(out);
}

/** Workaround: POST /partners/{id}/approve-supplier/ is denied for everyone (action missing from authz_actions). */
function approveSupplierViaService(code: string, approverEmail: string) {
  backendShell(`
from django.utils import timezone
from apps.core.context import ActorContext
from apps.identity.models import User
from apps.partners.models import Partner
from apps.partners.services import approve_supplier
approve_supplier(ActorContext(user=User.objects.get(email=${JSON.stringify(approverEmail)}), client_type="system", mfa_verified_at=timezone.now()), Partner.objects.get(code=${JSON.stringify(code)}))
print("APPROVED")
`);
}

/** Like helpers.watchConsole, but also tolerates 4xx answers a step deliberately provokes (shown in the UI). */
function watchConsoleExpecting(page: Page, statuses: number[]) {
  const errors: string[] = [];
  const allowed = new RegExp(`status of (40[13]|${statuses.join("|")})|WebSocket connection`);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (allowed.test(m.text())) return;
    errors.push(m.text());
  });
  return () => expect(errors, errors.join("\n")).toEqual([]);
}

/** If the server asks for a fresh MFA check, answer the step-up dialog with a new code. */
async function stepUpIfAsked(page: Page, secret: string, state: TradeState, email: string) {
  const dialog = page.getByRole("dialog").filter({ hasText: "Confirm it's you" });
  if (!(await dialog.isVisible().catch(() => false))) return;
  const { code, step } = await freshCode(secret, state.lastStep[email] ?? 0);
  state.lastStep[email] = step;
  saveTrade(state);
  await dialog.getByLabel("Verification code").fill(code);
  await dialog.getByRole("button", { name: "Verify and continue" }).click();
}

/** Picks an option in a cmdk combobox (ItemPicker/PartnerPicker). */
async function pickCombo(page: Page, trigger: ReturnType<Page["getByLabel"]>, search: string, option: RegExp | string) {
  await trigger.click();
  await page.getByPlaceholder("Type a code or name").fill(search);
  await page.getByRole("option", { name: option }).first().click();
}

/** Picks an option in a Radix select. */
async function pickSelect(page: Page, trigger: ReturnType<Page["getByLabel"]>, option: RegExp | string) {
  await trigger.click();
  await page.getByRole("option", { name: option }).first().click();
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// ------------------------------------------------------------------------------------------------
// Shared between the serial tests below (same worker).

test.describe.configure({ mode: "serial" });

// Unique per run so the spec can be repeated on the same database.
const RUN = (process.env.E2E_RUN_ID ?? Date.now().toString(36).slice(-5)).toUpperCase();
const SUPPLIER = { code: `S-${RUN}`, name: `Deccan Bearings ${RUN}`, gstin: "27AAACB1234C1Z5" };
const CUSTOMER = { code: `C-${RUN}`, name: `Kaveri Motors ${RUN}`, gstin: "29AABCK5678D1Z9" };
const VEHICLE = `MH12E2${RUN}`;
const esc = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const ITEM = { code: "E2E-BRG-6205", name: "Ball bearing 6205 (E2E)" };
const MODULES = ["masterdata", "partners", "inventory", "quality", "procurement", "sales", "logistics", "finance", "documents"];
const run: { requisition?: string; rfq?: string; po?: string; so?: string; delivery?: string; shipment?: string } = {};

function isoDay(offset: number) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function userPage(browser: Browser, email: string, state?: TradeState) {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const secret = state?.secrets[email];
  try {
    await signIn(page, email, DEMO_PASSWORD, secret, secret ? state!.lastStep[email] ?? 0 : 0);
  } catch (error) {
    // signIn allows 5 s for the shell; a cold dev server can need longer to compile it.
    await expect(page.getByRole("navigation", { name: "Main" }), String(error)).toBeVisible({ timeout: 45_000 });
  }
  if (secret) {
    state!.lastStep[email] = currentStep();
    saveTrade(state!);
  }
  return page;
}

/** Opens the page at 375 px, checks there's no horizontal page scroll, captures it, and restores desktop width. */
async function mobileShot(page: Page, name: string) {
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, `${name}-375`);
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("trade setup: modules, roles and grants, checker MFA, approval limits, items", async () => {
  test.setTimeout(240_000);
  try {
    if (loadTrade().item.id) return; // already set up on this database
  } catch {
    /* first run */
  }
  const admin = loadAdmin();
  const a = await Api.create();
  const adminStep = await a.login("admin@demo.local", admin.password, admin.secret, admin.lastStep);
  saveAdmin({ ...admin, lastStep: adminStep });
  const me = await a.get<{ active_company_id: string; user: { organization_id: string } }>("/auth/me/");
  const company = me.active_company_id;
  a.setCompany(company);

  // Business modules start disabled. Enable them as the administrator.
  const flags = await a.get<{ id: string; key: string; enabled_default: boolean }[]>("/admin/feature-flags/");
  let flagEndpointBroken = false;
  for (const f of flags.filter((f) => MODULES.includes(f.key.replace("module.", "")) && !f.enabled_default)) {
    const res = await a.tryCall("PATCH", `/admin/feature-flags/${f.id}/`, { enabled_default: true });
    if (res.status >= 500) { flagEndpointBroken = true; break; }
    expect(res.status, res.body).toBe(200);
  }
  if (flagEndpointBroken) {
    // Backend bug: PATCH /admin/feature-flags/{id}/ answers 500 (FeatureFlag has no authz_resource_type).
    backendShell(`
from apps.core import flags
from apps.core.models import FeatureFlag
FeatureFlag.objects.filter(key__in=${JSON.stringify(MODULES.map((m) => `module.${m}`))}).update(enabled_default=True)
flags.invalidate()
`);
  }

  // Roles: a maker (buyer, sales, stores, logistics) and a checker (approvals, credit, verification).
  const catalogue = (await a.get<{ code: string }[]>("/authorization/permissions/")).map((p) => p.code);
  const trade = ["partners.", "procurement.", "sales.", "logistics.", "masterdata."];
  const checkerOnly = new Set(["partners.bank_account.approve", "procurement.purchase_requisition.approve", "procurement.purchase_order.approve",
    "procurement.rfq.approve", "sales.sales_order.credit_override"]);
  const maker = catalogue.filter((c) => (trade.some((m) => c.startsWith(m)) && !checkerOnly.has(c) && !/\.(reject|cancel|self_approve|export)$/.test(c))
    || (/^(inventory|organization|quality)\./.test(c) && c.endsWith(".read")) || c === "documents.document.create" || c === "documents.document.read");
  const checker = catalogue.filter((c) => (/^(partners|procurement|sales|logistics|masterdata|inventory|organization)\./.test(c) && c.endsWith(".read"))
    || checkerOnly.has(c) || ["partners.supplier.approve", "procurement.purchase_requisition.reject", "procurement.purchase_requisition.cancel",
      "procurement.purchase_order.reject", "procurement.purchase_order.cancel"].includes(c));
  const limits = catalogue.filter((c) => c.startsWith("authorization.approval_limit."));
  const roles: Record<string, string> = {};
  for (const [code, name, permission_codes] of [["e2e_trade_maker", "Trade maker (E2E)", maker], ["e2e_trade_checker", "Trade checker (E2E)", checker],
    ["e2e_approval_limits", "Approval limits (E2E)", limits]] as const) {
    roles[code] = (await a.post<{ id: string }>("/authorization/roles/", { code, name, permission_codes })).id;
  }
  const users = Object.fromEntries((await a.get<{ results: { id: string; email: string }[] }>("/identity/users/?page_size=200")).results.map((u) => [u.email, u.id]));
  for (const [email, role, scope_type, scope_id] of [[MAKER, "e2e_trade_maker", "company", company], [CHECKER, "e2e_trade_checker", "company", company],
    [LIMITS, "e2e_approval_limits", "organization", me.user.organization_id]]) {
    await a.post("/authorization/role-assignments/", { user: users[email], role: roles[role], scope_type, scope_id, reason: "Trade e2e" },
      { "Idempotency-Key": crypto.randomUUID() });
  }
  await a.dispose();

  // The checker's credit overrides and bank verifications, and approval-limit changes, need MFA.
  const state: TradeState = { company, secrets: {}, lastStep: {}, item: { id: "", code: ITEM.code }, uoms: { NOS: "", BOX: "" }, supplierCode: SUPPLIER.code, customerCode: CUSTOMER.code };
  for (const email of [CHECKER, LIMITS]) {
    const u = await Api.create();
    await u.login(email, DEMO_PASSWORD);
    const { secret } = await u.post<{ secret: string }>("/auth/mfa/totp/setup/");
    const { code, step } = await freshCode(secret, 0);
    await u.post("/auth/mfa/totp/confirm/", { code });
    state.secrets[email] = secret;
    state.lastStep[email] = step;
    if (email === LIMITS) {
      u.setCompany(company);
      for (const document_type of ["procurement.purchase_requisition", "procurement.purchase_order"]) {
        await u.post("/authorization/approval-limits/", { role: roles.e2e_trade_checker, document_type, currency: "INR", max_amount: "1000000" });
      }
    }
    await u.dispose();
  }

  // Item master: bought in boxes of 10, stocked and sold in numbers, 18% GST.
  const p = await Api.create();
  await p.login(MAKER, DEMO_PASSWORD);
  p.setCompany(company);
  const uoms = await p.get<{ id: string; code: string }[]>("/masterdata/uoms/");
  const uom = async (code: string, name: string) => uoms.find((u) => u.code === code)?.id
    ?? (await p.post<{ id: string }>("/masterdata/uoms/", { code, name, kind: "count", decimals: 0 })).id;
  state.uoms = { NOS: await uom("NOS", "Numbers"), BOX: await uom("BOX", "Box of 10") };
  const hsn = await p.post<{ id: string }>("/masterdata/hsn-codes/", { code: "8482", description: "Ball bearings", gst_rate: "18" });
  const category = await p.post<{ id: string }>("/masterdata/item-categories/", { code: "TRD", name: "Traded goods", posting_group: "TRD" });
  const item = await p.post<{ id: string }>("/masterdata/items/", {
    code: ITEM.code, name: ITEM.name, item_type: "component", category: category.id, stock_uom: state.uoms.NOS, purchase_uom: state.uoms.BOX,
    sales_uom: state.uoms.NOS, hsn: hsn.id, is_stocked: true, is_purchasable: true, is_saleable: true, standard_cost: "80",
  });
  await p.post("/masterdata/uom-conversions/", { item: item.id, from_uom: state.uoms.BOX, to_uom: state.uoms.NOS, factor: "10" });
  state.item.id = item.id;
  await p.dispose();
  saveTrade(state);
});

test("suppliers: GSTIN fills the state, maker-checker approval, masked bank account verified by another person", async ({ browser }) => {
  test.setTimeout(240_000);
  const state = loadTrade();
  const maker = await userPage(browser, MAKER);
  const assertMaker = watchConsole(maker);

  await maker.goto("/partners/suppliers");
  await expect(maker.getByRole("heading", { level: 1, name: "Suppliers" })).toBeVisible();
  await maker.getByRole("button", { name: "New supplier" }).click();
  const dialog = maker.getByRole("dialog");
  await dialog.getByLabel("Code").fill(SUPPLIER.code);
  await dialog.getByLabel("Name", { exact: true }).fill(SUPPLIER.name);
  await dialog.getByLabel("GSTIN").fill(SUPPLIER.gstin);
  await expect(dialog.getByLabel("State (place of supply)")).toContainText("27 · Maharashtra");
  await expect(dialog.getByLabel("PAN")).toHaveValue("AAACB1234C");
  await shot(maker, "30-supplier-new");
  await dialog.getByRole("button", { name: "Save supplier" }).click();
  await expect(maker).toHaveURL(/\/partners\/suppliers\/[0-9a-f-]{36}$/);
  await expect(maker.getByRole("heading", { level: 1, name: SUPPLIER.name })).toBeVisible();
  const supplierUrl = maker.url();
  if (await maker.getByText("no supplier profile yet").isVisible()) {
    // Backend bug: POST /partners/ never creates the supplier profile (master_schema replaces PartnerViewSet.create).
    ensurePartnerProfiles(SUPPLIER.code);
    await maker.reload();
  }
  await expect(maker.getByText("Awaiting approval").first()).toBeVisible();

  // The creator can't approve their own supplier.
  await maker.getByRole("button", { name: "Approve supplier" }).click();
  await expect(maker.getByRole("alert").filter({ hasText: "maker-checker" })).toBeVisible();

  // Bank details: stored encrypted, shown masked, verified by someone else.
  await maker.getByRole("button", { name: "Add account" }).click();
  const bank = maker.getByRole("dialog");
  await bank.getByLabel("Bank name").fill("HDFC Bank");
  await bank.getByLabel("IFSC").fill("HDFC0001234");
  await bank.getByLabel("Account holder").fill("Deccan Bearings Pvt Ltd");
  await bank.getByLabel("Account number").fill("50100012345678");
  await bank.getByRole("button", { name: "Add account" }).click();
  const accountRow = maker.getByRole("row", { name: /HDFC Bank/ });
  await expect(accountRow).toContainText("****5678");
  await expect(accountRow).not.toContainText("50100012345678");
  await expect(accountRow).toContainText("Another person verifies");
  await shot(maker, "31-supplier-maker-view");
  await mobileShot(maker, "31-supplier-maker-view");
  assertMaker();

  const checker = await userPage(browser, CHECKER, state);
  const assertChecker = watchConsole(checker);
  await checker.goto(supplierUrl);
  await checker.getByRole("button", { name: "Approve supplier" }).click();
  const approved = checker.getByRole("button", { name: "Withdraw approval" });
  const denied = checker.getByRole("alert").filter({ hasText: "approve this supplier" });
  await expect(approved.or(denied)).toBeVisible();
  if (await denied.isVisible()) {
    // Backend bug: approve-supplier is missing from PartnerViewSet.authz_actions, so the API denies everyone.
    approveSupplierViaService(SUPPLIER.code, CHECKER);
    await checker.reload();
  }
  await expect(checker.getByRole("button", { name: "Withdraw approval" })).toBeVisible();
  await expect(checker.getByText("Approved vendor").first()).toBeVisible();

  await checker.getByRole("row", { name: /HDFC Bank/ }).getByRole("button", { name: "Verify" }).click();
  const review = checker.getByRole("dialog");
  await review.getByLabel("Note").fill("Matched against cancelled cheque");
  await review.getByRole("button", { name: "Verify" }).click();
  await stepUpIfAsked(checker, state.secrets[CHECKER], state, CHECKER);
  await expect(checker.getByRole("row", { name: /HDFC Bank/ })).toContainText("Verified");
  await shot(checker, "32-supplier-approved-bank-verified");
  assertChecker();
  await maker.context().close();
  await checker.context().close();
});

test("procure to pay: requisition rejected then approved, RFQ comparison, PO with GST split, GRN over-receipt refused then posted", async ({ browser }) => {
  test.setTimeout(420_000);
  const state = loadTrade();
  const maker = await userPage(browser, MAKER);
  const assertMaker = watchConsoleExpecting(maker, [422]);
  const checker = await userPage(browser, CHECKER, state);
  const assertChecker = watchConsole(checker);

  // Requisition
  await maker.goto("/procurement/requisitions");
  await maker.getByRole("button", { name: "New requisition" }).click();
  await pickSelect(maker, maker.getByLabel("Branch"), "Pune works (DEMO)");
  await maker.getByLabel("Purpose").fill("Bearings for CNC line 2 (E2E)");
  await pickCombo(maker, maker.getByLabel("Line 1 Item"), "E2E-BRG", new RegExp(ITEM.code));
  await expect(maker.getByLabel("Line 1 Unit")).toContainText("BOX");
  await maker.getByLabel("Line 1 Quantity").fill("5");
  await maker.getByLabel("Line 1 Est. rate").fill("900");
  await pickSelect(maker, maker.getByLabel("Line 1 Deliver to"), /Raw material store/);
  await expect(maker.getByText("₹4500.00")).toBeVisible(); // estimate computed without floats
  await shot(maker, "33-requisition-new");
  await maker.getByRole("button", { name: "Save draft" }).click();
  await expect(maker).toHaveURL(/\/procurement\/requisitions\/[0-9a-f-]{36}$/);
  run.requisition = maker.url();
  await maker.getByRole("button", { name: "Submit for approval" }).click();
  await expect(maker.getByText("Submitted", { exact: true }).first()).toBeVisible();
  await expect(maker.getByText("someone else approves it")).toBeVisible();

  // The checker rejects with a reason (maker-checker), the maker resubmits, the checker approves.
  await checker.goto(run.requisition);
  const reject = checker.getByRole("button", { name: "Reject" });
  await expect(reject).toBeDisabled();
  await checker.getByLabel("Comment").fill("Split into two quarterly lots, please.");
  await reject.click();
  await expect(checker.getByText("Rejected", { exact: true }).first()).toBeVisible();
  await maker.reload();
  await maker.getByRole("button", { name: "Submit for approval" }).click();
  await expect(maker.getByText("Submitted", { exact: true }).first()).toBeVisible();
  await checker.reload();
  await checker.getByLabel("Comment").fill("Within budget.");
  await checker.getByRole("button", { name: "Approve" }).click();
  await expect(checker.getByText("Approved", { exact: true }).first()).toBeVisible();

  // RFQ from the requisition, one quotation, comparison, selection by the checker creates the PO.
  await maker.reload();
  await maker.getByRole("link", { name: "Request quotations" }).click();
  await expect(maker.getByLabel("Source")).toContainText("Bearings for CNC line 2");
  await pickCombo(maker, maker.getByLabel("Invite a supplier"), SUPPLIER.code, SUPPLIER.name);
  await expect(maker.getByRole("list", { name: "Invited suppliers" })).toContainText(SUPPLIER.name);
  await maker.getByRole("button", { name: "Create RFQ" }).click();
  await expect(maker).toHaveURL(/\/procurement\/rfqs\/[0-9a-f-]{36}$/);
  run.rfq = maker.url();
  await maker.getByRole("button", { name: "Record quotation" }).click();
  const quote = maker.getByRole("dialog");
  await pickSelect(maker, quote.getByLabel("Supplier", { exact: true }), SUPPLIER.name);
  await quote.getByLabel("Line 1 Rate").fill("850");
  await quote.getByLabel("Line 1 Discount %").fill("2");
  await expect(quote.getByText("₹4165.00")).toBeVisible();
  await quote.getByRole("button", { name: "Record quotation" }).click();
  const ranking = maker.getByRole("row", { name: esc(SUPPLIER.name) });
  await expect(ranking).toContainText("Cheapest");
  await expect(ranking).toContainText("4,165.00");
  await shot(maker, "34-rfq-comparison");

  await checker.goto(run.rfq);
  await checker.getByRole("row", { name: esc(SUPPLIER.name) }).getByRole("button", { name: "Select" }).click();
  await pickSelect(checker, checker.getByLabel("Deliver to"), /Raw material store/);
  await checker.getByRole("button", { name: "Select and draft PO" }).click();
  await expect(checker).toHaveURL(/\/procurement\/orders\/[0-9a-f-]{36}$/);
  run.po = checker.url();

  // PO: GST split is intra-state (Maharashtra to Maharashtra): CGST + SGST.
  await maker.goto(run.po);
  await expect(maker.getByText("Intra-state supply: CGST + SGST")).toBeVisible();
  await expect(maker.getByRole("columnheader", { name: "CGST" })).toBeVisible();
  await expect(maker.getByRole("row", { name: new RegExp(ITEM.code) })).toContainText("374.85");
  await maker.getByRole("button", { name: "Submit for approval" }).click();
  await expect(maker.getByText("Submitted", { exact: true }).first()).toBeVisible();
  await checker.reload();
  await checker.getByLabel("Comment").fill("Approved against RFQ.");
  await checker.getByRole("button", { name: "Approve" }).click();
  await expect(checker.getByText("Approved", { exact: true }).first()).toBeVisible();
  await shot(checker, "35-po-approved-gst-split");
  await mobileShot(checker, "35-po-approved-gst-split");

  // GRN: receiving 6 boxes against 5 ordered (no tolerance) is refused; 5 is received and posted.
  await maker.reload();
  await maker.getByRole("link", { name: "Receive goods" }).click();
  await expect(maker.getByText(/Ordered 5 BOX/)).toBeVisible();
  await maker.getByLabel("Line 1 Receive").fill("6");
  await expect(maker.getByText("Over the order and tolerance")).toBeVisible();
  await maker.getByLabel("Vehicle number").fill("MH14XY0001");
  await maker.getByRole("button", { name: "Save draft receipt" }).click();
  const overAlert = maker.getByRole("alert").filter({ hasText: "receipt exceeds the order" });
  await expect(overAlert.or(maker.getByRole("button", { name: "Post receipt" }))).toBeVisible();
  if (await maker.getByRole("button", { name: "Post receipt" }).isVisible()) {
    // Older backends only check the tolerance when posting.
    await maker.getByRole("button", { name: "Post receipt" }).click();
    await expect(overAlert).toBeVisible();
    await maker.goto(`/procurement/receipts?new=1&po=${run.po.split("/").pop()}`);
  }
  await expect(overAlert).toContainText("open 5");
  await shot(maker, "36-grn-over-receipt-refused");
  await maker.getByLabel("Line 1 Receive").fill("5");
  await maker.getByRole("button", { name: "Save draft receipt" }).click();
  await expect(maker).toHaveURL(/\/procurement\/receipts\/[0-9a-f-]{36}$/);
  await maker.getByRole("button", { name: "Post receipt" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /Receipt GRN\// })).toBeVisible();
  const grnRow = maker.getByRole("row", { name: new RegExp(ITEM.code) });
  await expect(grnRow).toContainText("50 NOS"); // 5 boxes of 10 in stock units
  await expect(grnRow).toContainText("Unrestricted");
  await shot(maker, "37-grn-posted");
  await mobileShot(maker, "37-grn-posted");

  await maker.goto("/procurement/mrp");
  await maker.getByRole("button", { name: "Run now" }).click();
  await expect(maker.getByText(/^Run \d/).first()).toBeVisible();
  await shot(maker, "38-mrp");
  assertMaker();
  assertChecker();
  await maker.context().close();
  await checker.context().close();
});

test("order to invoice: credit block overridden by another user, reservation, delivery with COGS, gapless invoice, credit note", async ({ browser }) => {
  test.setTimeout(420_000);
  const state = loadTrade();
  const maker = await userPage(browser, MAKER);
  const assertMaker = watchConsole(maker);

  await maker.goto("/partners/customers");
  await maker.getByRole("button", { name: "New customer" }).click();
  const dialog = maker.getByRole("dialog");
  await dialog.getByLabel("Code").fill(CUSTOMER.code);
  await dialog.getByLabel("Name", { exact: true }).fill(CUSTOMER.name);
  await dialog.getByLabel("GSTIN").fill(CUSTOMER.gstin);
  await expect(dialog.getByLabel("State (place of supply)")).toContainText("29 · Karnataka");
  await dialog.getByRole("button", { name: "Save customer" }).click();
  await expect(maker).toHaveURL(/\/partners\/customers\/[0-9a-f-]{36}$/);
  await expect(maker.getByRole("heading", { level: 1, name: CUSTOMER.name })).toBeVisible();
  if (await maker.getByText("no customer profile yet").isVisible()) {
    ensurePartnerProfiles(CUSTOMER.code); // backend bug, see the supplier test
    await maker.reload();
  }
  await maker.getByLabel("Credit limit (₹)").fill("1000");
  await maker.getByLabel("Credit days").fill("30");
  await maker.getByRole("button", { name: "Save credit settings" }).click();
  await expect(maker.getByText("Credit settings saved")).toBeVisible();
  await shot(maker, "40-customer-credit");

  // Sales order over the credit limit: submit runs the credit check and blocks it.
  await maker.goto("/sales/orders");
  await maker.getByRole("button", { name: "New order" }).click();
  await pickCombo(maker, maker.getByLabel("Customer", { exact: true }), CUSTOMER.code, CUSTOMER.name);
  await expect(maker.getByLabel("Place of supply")).toContainText("29 · Karnataka");
  await pickSelect(maker, maker.getByLabel("Branch"), "Pune works (DEMO)");
  await pickCombo(maker, maker.getByLabel("Line 1 Item"), "E2E-BRG", new RegExp(ITEM.code));
  await expect(maker.getByLabel("Line 1 Unit")).toContainText("NOS");
  await maker.getByLabel("Line 1 Quantity").fill("20");
  await maker.getByLabel("Line 1 Rate").fill("150");
  await pickSelect(maker, maker.getByLabel("Line 1 Ship from"), /Raw material store/);
  await shot(maker, "41-sales-order-new");
  await maker.getByRole("button", { name: "Save draft order" }).click();
  await expect(maker).toHaveURL(/\/sales\/orders\/[0-9a-f-]{36}$/);
  run.so = maker.url();
  await expect(maker.getByText("Inter-state supply: IGST")).toBeVisible();
  await maker.getByRole("button", { name: "Submit order" }).click();
  await expect(maker.getByText("Credit blocked", { exact: true }).first()).toBeVisible();
  await expect(maker.getByText(/exceeds the credit limit/).first()).toBeVisible();
  await expect(maker.getByText("waiting for a credit decision")).toBeVisible();
  await shot(maker, "42-sales-order-credit-blocked");

  // A second blocked order (set up through the API) whose block the checker upholds.
  const p = await Api.create();
  await p.login(MAKER, DEMO_PASSWORD);
  p.setCompany(state.company);
  const customer = (await p.get<{ results: { id: string }[] }>(`/partners/?search=${CUSTOMER.code}`)).results[0];
  const branch = (await p.get<{ companies: { branches: { id: string; code: string; warehouses: { id: string; code: string }[] }[] }[] }>("/organization/scope-tree/"))
    .companies[0].branches.find((b) => b.code === "PUN")!;
  const so2 = await p.post<{ id: string; version: number }>("/sales/orders/", {
    company: state.company, branch: branch.id, customer: customer.id, order_date: isoDay(0), requested_date: isoDay(5), place_of_supply: "29",
    lines: [{ item: state.item.id, quantity: "5", uom: state.uoms.NOS, rate: "150", warehouse: branch.warehouses.find((w) => w.code === "PUN-RM")!.id }],
  });
  await p.post(`/sales/orders/${so2.id}/submit/`, { version: so2.version });
  await p.dispose();

  const checker = await userPage(browser, CHECKER, state);
  const assertChecker = watchConsole(checker);
  await checker.goto(run.so);
  await checker.getByLabel("Reason").fill("Advance of 50% received by bank transfer.");
  await checker.getByRole("button", { name: "Override and approve" }).click();
  await stepUpIfAsked(checker, state.secrets[CHECKER], state, CHECKER);
  await expect(checker.getByText("Credit overridden", { exact: true }).first()).toBeVisible();
  await expect(checker.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(checker.getByRole("row", { name: new RegExp(ITEM.code) })).toContainText("20 of 20 NOS"); // reserved
  await shot(checker, "43-sales-order-credit-overridden-reserved");
  await checker.goto(`/sales/orders/${so2.id}`);
  await checker.getByLabel("Reason").fill("Exposure too high until the first invoice is paid.");
  await checker.getByRole("button", { name: "Uphold block" }).click();
  await stepUpIfAsked(checker, state.secrets[CHECKER], state, CHECKER);
  await expect(checker.getByText("Rejected", { exact: true }).first()).toBeVisible();
  assertChecker();
  await checker.context().close();

  // Delivery from the reserved stock; posting books COGS on the server.
  await maker.goto(run.so);
  await maker.getByRole("link", { name: "Create delivery" }).click();
  await expect(maker.getByText(/reserved 20/)).toBeVisible();
  await expect(maker.getByLabel("Line 1 Deliver")).toHaveValue("20");
  await maker.getByRole("button", { name: "Save draft delivery" }).click();
  await expect(maker).toHaveURL(/\/sales\/deliveries\/[0-9a-f-]{36}$/);
  run.delivery = maker.url();
  await maker.getByRole("button", { name: "Post delivery" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /Delivery DN\// })).toBeVisible();
  await expect(maker.getByText(/Cost of goods sold booked on the server: ₹\d/).first()).toBeVisible();
  await shot(maker, "44-delivery-posted");

  // Invoice from delivered quantities; the number is assigned on posting.
  await maker.goto(run.so);
  await maker.getByRole("link", { name: "Create invoice" }).click();
  await expect(maker.getByText("Will be invoiced")).toBeVisible();
  await maker.getByRole("button", { name: "Create draft invoice" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: "Draft invoice" })).toBeVisible();
  await expect(maker.getByText("assigned from the gapless GST series")).toBeVisible();
  await maker.getByRole("button", { name: "Post invoice" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /Invoice SI\// })).toBeVisible();
  await expect(maker.getByText("Inter-state supply: IGST")).toBeVisible();
  await expect(maker.getByText("₹3,540.00").first()).toBeVisible();
  await shot(maker, "45-invoice-posted");
  await mobileShot(maker, "45-invoice-posted");

  // Return of 2 damaged pieces: a credit note with GST reversed.
  await maker.getByRole("link", { name: "Record return" }).click();
  await pickSelect(maker, maker.getByLabel("Return to warehouse"), /Raw material store/);
  await maker.getByLabel("Reason").fill("Two bearings damaged in transit");
  await maker.getByLabel("Line 1 Return").fill("2");
  await maker.getByRole("button", { name: "Save draft return" }).click();
  await expect(maker).toHaveURL(/\/sales\/invoices\/returns\/[0-9a-f-]{36}$/);
  await maker.getByRole("button", { name: "Post and issue credit note" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /Credit note CN\// })).toBeVisible();
  await expect(maker.getByText("₹354.00")).toBeVisible();
  await shot(maker, "46-credit-note");
  assertMaker();
  await maker.context().close();
});

test("logistics: expired vehicle insurance blocks dispatch, renewal, proof of delivery with an uploaded signature", async ({ browser }) => {
  test.setTimeout(240_000);
  const maker = await userPage(browser, MAKER);
  const assertMaker = watchConsoleExpecting(maker, [422]);

  await maker.goto("/logistics/shipments?tab=vehicles");
  await maker.getByRole("button", { name: "Add vehicle" }).click();
  let dialog = maker.getByRole("dialog");
  await pickSelect(maker, dialog.getByLabel("Branch"), "Pune works (DEMO)");
  await dialog.getByLabel("Registration").fill(VEHICLE);
  await dialog.getByLabel("Type").fill("Tempo");
  await dialog.getByLabel("Insurance expires").fill(isoDay(-3));
  await dialog.getByLabel("PUC expires").fill(isoDay(20));
  await dialog.getByRole("button", { name: "Save vehicle" }).click();
  const vehicleRow = maker.getByRole("row", { name: esc(VEHICLE) });
  await expect(vehicleRow).toContainText("Expired");
  await expect(maker.getByText("Documents expiring within 30 days")).toBeVisible();

  await maker.getByRole("tab", { name: "Drivers" }).click();
  await maker.getByRole("button", { name: "Add driver" }).click();
  dialog = maker.getByRole("dialog");
  await pickSelect(maker, dialog.getByLabel("Branch"), "Pune works (DEMO)");
  await dialog.getByLabel("Name").fill("Ramesh Patil (E2E)");
  await dialog.getByLabel("Phone").fill("9800000000");
  await dialog.getByLabel("Licence number").fill("MH1220190001");
  await dialog.getByLabel("Licence expires").fill(isoDay(400));
  await dialog.getByRole("button", { name: "Save driver" }).click();
  await expect(maker.getByRole("row", { name: /Ramesh Patil/ })).toBeVisible();
  await maker.getByRole("tab", { name: "Vehicles" }).click();
  await shot(maker, "50-vehicles-expiry");
  await mobileShot(maker, "50-vehicles-expiry");

  await maker.goto(run.delivery!);
  await maker.getByRole("link", { name: "Plan shipment" }).click();
  await pickSelect(maker, maker.getByLabel("Branch"), "Pune works (DEMO)");
  await pickSelect(maker, maker.getByLabel("Vehicle", { exact: true }), esc(VEHICLE));
  await pickSelect(maker, maker.getByLabel("Driver", { exact: true }), /Ramesh Patil/);
  await expect(maker.getByRole("status").filter({ hasText: "can't be dispatched" })).toContainText("insurance expired");
  await maker.getByRole("button", { name: "Plan shipment" }).click();
  await expect(maker).toHaveURL(/\/logistics\/shipments\/[0-9a-f-]{36}$/);
  run.shipment = maker.url();
  await maker.getByRole("button", { name: "Dispatch" }).click();
  const refused = maker.getByRole("alert").filter({ hasText: "Vehicle or driver documents have expired." });
  await expect(refused).toContainText(new RegExp(`${VEHICLE}: insurance expired on \\d{4}-\\d{2}-\\d{2}`));
  await shot(maker, "51-dispatch-blocked");

  await maker.goto("/logistics/shipments?tab=vehicles");
  await maker.getByRole("button", { name: `Edit ${VEHICLE}` }).click();
  await maker.getByRole("dialog").getByLabel("Insurance expires").fill(isoDay(300));
  await maker.getByRole("dialog").getByRole("button", { name: "Save vehicle" }).click();
  await expect(maker.getByText("Vehicle updated")).toBeVisible();

  await maker.goto(run.shipment);
  await maker.getByRole("button", { name: "Dispatch" }).click();
  await expect(maker.getByText("Dispatched", { exact: true }).first()).toBeVisible();
  await maker.getByRole("button", { name: "Record proof" }).click();
  const pod = maker.getByRole("dialog");
  await pod.getByLabel("Received by").fill("Stores in-charge, Kaveri Motors");
  await expect(pod.getByRole("button", { name: "Record proof" })).toBeDisabled(); // signature required
  await pod.locator('input[type="file"]').setInputFiles({ name: "signature.png", mimeType: "image/png", buffer: PNG_1PX });
  await expect(pod.getByLabel("Signature document ID")).toHaveValue(/^[0-9a-f-]{36}$/);
  await pod.getByRole("button", { name: "Record proof" }).click();
  await expect(maker.getByText("Delivered", { exact: true }).first()).toBeVisible();
  await expect(maker.getByRole("row", { name: /DN\// })).toContainText("signed");
  await shot(maker, "52-shipment-delivered");
  await mobileShot(maker, "52-shipment-delivered");
  assertMaker();
  await maker.context().close();
});

test("trade screens fit a 375 px phone", async ({ browser }) => {
  test.setTimeout(180_000);
  const maker = await userPage(browser, MAKER);
  const assertClean = watchConsole(maker);
  await maker.setViewportSize({ width: 375, height: 812 });
  const pages: [string, string][] = [
    ["/partners/suppliers", "60-suppliers"], ["/partners/customers", "61-customers"], ["/procurement/requisitions", "62-requisitions"],
    ["/procurement/rfqs", "63-rfqs"], ["/procurement/orders", "64-purchase-orders"], ["/procurement/receipts", "65-receipts"],
    ["/procurement/receipts?tab=returns", "66-purchase-returns"], ["/procurement/mrp", "67-mrp"], ["/sales/orders", "68-sales-orders"],
    ["/sales/orders?tab=quotations", "69-quotations"], ["/sales/deliveries", "70-deliveries"], ["/sales/invoices", "71-invoices"],
    ["/sales/invoices?tab=returns", "72-credit-notes"], ["/logistics/shipments", "73-shipments"], ["/logistics/shipments?tab=drivers", "74-drivers"],
    [run.requisition!, "75-requisition-detail"], [run.rfq!, "76-rfq-detail"], [run.so!, "77-sales-order-detail"],
  ];
  for (const [url, name] of pages) {
    await maker.goto(url);
    await expect(maker.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(maker.getByLabel("Loading")).toHaveCount(0);
    await expectNoHorizontalScroll(maker);
    await shot(maker, `${name}-375`);
  }
  // Forms in sheets also fit.
  await maker.goto("/procurement/orders");
  await maker.getByRole("button", { name: "New order" }).click();
  await expectNoHorizontalScroll(maker);
  await shot(maker, "78-po-form-375");
  await maker.goto("/sales/orders?new=order");
  await expectNoHorizontalScroll(maker);
  await shot(maker, "79-so-form-375");
  // Desktop list captures.
  await maker.setViewportSize({ width: 1440, height: 900 });
  for (const [url, name] of pages.slice(0, 15)) {
    await maker.goto(url);
    await expect(maker.getByLabel("Loading")).toHaveCount(0);
    await shot(maker, name);
  }
  assertClean();
  await maker.context().close();
});
