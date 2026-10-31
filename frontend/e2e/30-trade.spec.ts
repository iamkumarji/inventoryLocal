/**
 * Partners, procurement, sales and logistics screens, end to end against a real stack: supplier onboarding
 * (maker-checker approval, bank account verification), procure-to-pay (requisition with rejection and
 * cancellation, RFQ with competing quotations, PO approval, GRN with over-receipt refusal and quality hold,
 * purchase return), MRP, order-to-cash (quotation, order, credit block overridden or upheld by another
 * user, delivery, gapless invoice, credit note), and logistics (vehicles, drivers, dispatch refused on
 * expired documents, proof of delivery), with phone-width layout checks.
 *
 * Setup data (roles, grants, MFA for the checkers, items, a second supplier) is created through the API;
 * every workflow step under test is driven in the browser.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect as baseExpect, request, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";

import { currentStep, DEMO_PASSWORD, expectNoHorizontalScroll, loadAdmin, saveAdmin, shot, signIn, totp, watchConsole } from "./helpers";

// Dev servers compile each route on first use; give UI assertions room for that.
const expect = baseExpect.configure({ timeout: 20_000 });

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const STATE = path.join(process.env.E2E_STATE_DIR ?? path.join(__dirname, ".state"), "trade.json");

const MAKER = "priya.requester@demo.local";
const CHECKER = "meera.planthead@demo.local";
const LIMITS = "rahul.supervisor@demo.local";

/** URLs of documents made by earlier tests, so a single test can be re-run on the same database. */
type RunUrls = {
  supplier?: string; requisition?: string; rfq?: string; po?: string; grn?: string; po2?: string; grn2?: string; purchaseReturn?: string;
  quotation?: string; so?: string; so2?: string; delivery?: string; invoice?: string; creditNote?: string; shipment?: string; customer?: string;
};

type TradeState = {
  run: string;
  company: string;
  secrets: Record<string, string>;
  lastStep: Record<string, number>;
  item: { id: string; code: string };
  seal: { id: string; code: string };
  uoms: { NOS: string; BOX: string };
  urls: RunUrls;
};

/** Writes the state; URLs recorded meanwhile for the same run (by `remember`) are kept. */
function saveTrade(state: TradeState) {
  mkdirSync(path.dirname(STATE), { recursive: true });
  let saved: TradeState | null = null;
  try {
    saved = loadTrade();
  } catch {
    /* first write */
  }
  if (saved && saved.run === state.run) state.urls = { ...saved.urls, ...state.urls };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}

function loadTrade(): TradeState {
  return JSON.parse(readFileSync(STATE, "utf8"));
}

/** Records a document URL for later tests (and re-runs). */
function remember(key: keyof RunUrls, url: string) {
  const state = loadTrade();
  state.urls[key] = url;
  saveTrade(state);
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

  /** Signs in as a seeded user of the trade test (with MFA when the user has it) for the active company. */
  static async as(email: string, state: TradeState) {
    const api = await Api.create();
    const secret = state.secrets[email];
    const step = await api.login(email, DEMO_PASSWORD, secret, state.lastStep[email] ?? 0);
    if (step) {
      state.lastStep[email] = step;
      saveTrade(state);
    }
    api.setCompany(state.company);
    return api;
  }

  async dispose() {
    await this.ctx.dispose();
  }
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

/** If the server asks for a fresh MFA check, answer the step-up dialog with a new code; waits until `done` shows. */
async function stepUpIfAsked(page: Page, state: TradeState, email: string, done: Locator) {
  const dialog = page.getByRole("dialog").filter({ hasText: "Confirm it's you" });
  await expect(dialog.or(done).first()).toBeVisible();
  if (!(await dialog.isVisible())) return;
  const secret = state.secrets[email];
  const { code, step } = await freshCode(secret, state.lastStep[email] ?? 0);
  state.lastStep[email] = step;
  saveTrade(state);
  await dialog.getByLabel("Verification code").fill(code);
  await dialog.getByRole("button", { name: "Verify and continue" }).click();
  await expect(done.first()).toBeVisible();
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
// Serial tests sharing state through the state file (same worker).

test.describe.configure({ mode: "serial" });

const esc = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const ITEM = { code: "E2E-BRG-6205", name: "Ball bearing 6205 (E2E)" };
const SEAL = { code: "E2E-SEAL-35", name: "Oil seal 35 mm (E2E, inspected)" };
const MODULES = ["masterdata", "partners", "inventory", "quality", "procurement", "sales", "logistics", "finance", "documents"];

/** Codes and names unique per run, so the spec can be repeated on the same database. */
function names(run: string) {
  return {
    supplier: { code: `S-${run}`, name: `Deccan Bearings ${run}`, gstin: "27AAACB1234C1Z5" },
    supplier2: { code: `S2-${run}`, name: `Nilgiri Seals ${run}`, gstin: "29AAACS4321K1Z3" },
    customer: { code: `C-${run}`, name: `Kaveri Motors ${run}`, gstin: "29AABCK5678D1Z9" },
    vehicle: `MH12E2${run}`,
  };
}

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

/** The branch and raw-material store of the seeded Pune works. */
async function pune(api: Api) {
  const branch = (await api.get<{ companies: { branches: { id: string; code: string; warehouses: { id: string; code: string }[] }[] }[] }>("/organization/scope-tree/"))
    .companies[0].branches.find((b) => b.code === "PUN")!;
  return { branch: branch.id, rm: branch.warehouses.find((w) => w.code === "PUN-RM")!.id };
}

test("trade setup: modules, roles and grants, checker MFA, approval limits, items, a second approved supplier", async () => {
  test.setTimeout(240_000);
  let state: TradeState | null = null;
  try {
    state = loadTrade();
    if (!state.item.id || !state.seal?.id) state = null;
  } catch {
    state = null; // first run on this database
  }

  if (!state) {
    const admin = loadAdmin();
    const a = await Api.create();
    const adminStep = await a.login("admin@demo.local", admin.password, admin.secret, admin.lastStep);
    saveAdmin({ ...admin, lastStep: adminStep });
    const me = await a.get<{ active_company_id: string; user: { organization_id: string } }>("/auth/me/");
    const company = me.active_company_id;
    a.setCompany(company);

    // Business modules start disabled; the administrator turns them on for the organization.
    const flags = await a.get<{ id: string; key: string; enabled_default: boolean }[]>("/admin/feature-flags/");
    for (const f of flags.filter((f) => MODULES.includes(f.key.replace("module.", "")) && !f.enabled_default)) {
      const res = await a.tryCall("PATCH", `/admin/feature-flags/${f.id}/`, { enabled_default: true });
      expect(res.status, res.body).toBe(200);
    }

    // Roles: a maker (buyer, sales, stores, logistics) and a checker (approvals, credit, verification).
    const catalogue = (await a.get<{ code: string }[]>("/authorization/permissions/")).map((p) => p.code);
    const trade = ["partners.", "procurement.", "sales.", "logistics.", "masterdata."];
    const checkerOnly = new Set(["partners.bank_account.approve", "procurement.purchase_requisition.approve", "procurement.purchase_order.approve",
      "procurement.rfq.approve", "sales.sales_order.credit_override"]);
    const maker = catalogue.filter((c) => (trade.some((m) => c.startsWith(m)) && !checkerOnly.has(c) && !/\.(reject|cancel|self_approve|export)$/.test(c))
      || (/^(inventory|organization|quality)\./.test(c) && c.endsWith(".read")) || c === "documents.document.create" || c === "documents.document.read"
      || c === "procurement.purchase_requisition.cancel"); // buyers withdraw their own requests
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
    state = { run: "", company, secrets: {}, lastStep: {}, item: { id: "", code: ITEM.code }, seal: { id: "", code: SEAL.code }, uoms: { NOS: "", BOX: "" }, urls: {} };
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

    // Item master: bearings bought in boxes of 10, stocked and sold in numbers; oil seals inspected on receipt. 18% GST.
    const p = await Api.create();
    await p.login(MAKER, DEMO_PASSWORD);
    p.setCompany(company);
    const uoms = await p.get<{ id: string; code: string }[]>("/masterdata/uoms/");
    const uom = async (code: string, name: string) => uoms.find((u) => u.code === code)?.id
      ?? (await p.post<{ id: string }>("/masterdata/uoms/", { code, name, kind: "count", decimals: 0 })).id;
    state.uoms = { NOS: await uom("NOS", "Numbers"), BOX: await uom("BOX", "Box of 10") };
    const hsn = await p.post<{ id: string }>("/masterdata/hsn-codes/", { code: "8482", description: "Ball bearings", gst_rate: "18" });
    const hsnSeal = await p.post<{ id: string }>("/masterdata/hsn-codes/", { code: "4016", description: "Rubber seals", gst_rate: "18" });
    const category = await p.post<{ id: string }>("/masterdata/item-categories/", { code: "TRD", name: "Traded goods", posting_group: "TRD" });
    const item = await p.post<{ id: string }>("/masterdata/items/", {
      code: ITEM.code, name: ITEM.name, item_type: "component", category: category.id, stock_uom: state.uoms.NOS, purchase_uom: state.uoms.BOX,
      sales_uom: state.uoms.NOS, hsn: hsn.id, is_stocked: true, is_purchasable: true, is_saleable: true, standard_cost: "80",
    });
    await p.post("/masterdata/uom-conversions/", { item: item.id, from_uom: state.uoms.BOX, to_uom: state.uoms.NOS, factor: "10" });
    const seal = await p.post<{ id: string }>("/masterdata/items/", {
      code: SEAL.code, name: SEAL.name, item_type: "component", category: category.id, stock_uom: state.uoms.NOS, purchase_uom: state.uoms.NOS,
      sales_uom: state.uoms.NOS, hsn: hsnSeal.id, is_stocked: true, is_purchasable: true, is_saleable: true, standard_cost: "25", inspection_required: true,
    });
    state.item.id = item.id;
    state.seal.id = seal.id;
    await p.dispose();
  }

  // Every run: fresh codes, and a second supplier (Karnataka, so purchases from it carry IGST) approved by the checker.
  state.run = (process.env.E2E_RUN_ID ?? Date.now().toString(36).slice(-5)).toUpperCase();
  state.urls = {}; // a new run: saveTrade only merges URLs of the same run
  saveTrade(state);
  const n = names(state.run);
  const maker = await Api.as(MAKER, state);
  const s2 = await maker.post<{ id: string; supplier_profile: unknown }>("/partners/", {
    code: n.supplier2.code, name: n.supplier2.name, gst_registration: "regular", gstin: n.supplier2.gstin, state_code: "29", pan: n.supplier2.gstin.slice(2, 12),
    is_supplier: true, is_customer: false,
  });
  expect(s2.supplier_profile, "partner create makes the supplier profile").toBeTruthy();
  await maker.dispose();
  const checker = await Api.as(CHECKER, state);
  await checker.post(`/partners/${s2.id}/approve-supplier/`, { approve: true, note: "Vendor audit passed (E2E setup)" });
  await checker.dispose();
});

test("suppliers: GSTIN fills the state, details, terms, address and contact, maker-checker approval, masked bank account verified by another person", async ({ browser }) => {
  test.setTimeout(240_000);
  const state = loadTrade();
  const { supplier: SUPPLIER } = names(state.run);
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
  remember("supplier", supplierUrl);
  await expect(maker.getByText("no supplier profile yet")).toHaveCount(0);
  await expect(maker.getByText("Awaiting approval").first()).toBeVisible();

  // The creator can't approve their own supplier: the server names the control.
  await maker.getByRole("button", { name: "Approve supplier" }).click();
  const denied = maker.getByRole("alert").filter({ hasText: /something you created or submitted|Another person must check this/ });
  await expect(denied).toBeVisible();
  await expect(denied).not.toContainText("You can't do this"); // the specific control, not the generic copy

  // Details, terms, an address and a contact.
  await maker.getByLabel("Phone", { exact: true }).fill("02024561234");
  await maker.getByRole("button", { name: "Save details" }).click();
  await expect(maker.getByText("Partner details saved")).toBeVisible();
  await maker.getByLabel("Payment terms (days)").fill("45");
  await maker.getByLabel("Lead time (days)").fill("7");
  await maker.getByRole("button", { name: "Save terms" }).click();
  await expect(maker.getByText("Supplier terms saved")).toBeVisible();
  await maker.getByRole("button", { name: "Address", exact: true }).click();
  let form = maker.getByRole("dialog");
  await form.getByLabel("Address line 1").fill("Plot 14, MIDC Bhosari");
  await form.getByLabel("City").fill("Pune");
  await form.getByLabel("PIN code").fill("411026");
  await expect(form.getByLabel("State")).toContainText("Maharashtra");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(maker.getByText("Plot 14, MIDC Bhosari")).toBeVisible();
  await maker.getByRole("button", { name: "Contact", exact: true }).click();
  form = maker.getByRole("dialog");
  await form.getByLabel("Name").fill("Anil Kulkarni");
  await form.getByLabel("Role").fill("Sales manager");
  await form.getByLabel("Email").fill("anil@deccan.example");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(maker.getByText("anil@deccan.example")).toBeVisible();

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
  await expect(checker.getByRole("button", { name: "Withdraw approval" })).toBeVisible();
  await expect(checker.getByText("Approved vendor").first()).toBeVisible();

  await checker.getByRole("row", { name: /HDFC Bank/ }).getByRole("button", { name: "Verify" }).click();
  const review = checker.getByRole("dialog");
  await review.getByLabel("Note").fill("Matched against cancelled cheque");
  await review.getByRole("button", { name: "Verify" }).click();
  await stepUpIfAsked(checker, state, CHECKER, checker.getByRole("row", { name: /HDFC Bank/ }).getByText("Verified"));
  await shot(checker, "32-supplier-approved-bank-verified");
  assertChecker();
  await maker.context().close();
  await checker.context().close();
});

test("procure to pay: requisition rejected then approved, another cancelled, RFQ with two quotations, PO approval, GRN over-receipt refused, quality hold, purchase return, PO cancel, MRP", async ({ browser }) => {
  test.setTimeout(480_000);
  const state = loadTrade();
  const { supplier: SUPPLIER, supplier2: SUPPLIER2 } = names(state.run);
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
  const requisition = maker.url();
  remember("requisition", requisition);
  await maker.getByRole("button", { name: "Submit for approval" }).click();
  await expect(maker.getByText("Submitted", { exact: true }).first()).toBeVisible();
  await expect(maker.getByText("someone else approves it")).toBeVisible();

  // The checker rejects with a reason (maker-checker), the maker resubmits, the checker approves.
  await checker.goto(requisition);
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

  // A second requisition (drafted through the API) is withdrawn by the buyer with a reason.
  const api = await Api.as(MAKER, state);
  const { branch, rm } = await pune(api);
  const supplierId = (await api.get<{ results: { id: string }[] }>(`/partners/?search=${SUPPLIER.code}`)).results[0].id;
  const pr2 = await api.post<{ id: string }>("/procurement/requisitions/", {
    company: state.company, branch, needed_by: isoDay(10), purpose: "Spare bearings, duplicate request (E2E)",
    lines: [{ item: state.item.id, quantity: "2", uom: state.uoms.BOX, estimated_rate: "900", warehouse: rm }],
  });
  const draftPo = await api.post<{ id: string }>("/procurement/orders/", {
    company: state.company, branch, supplier: supplierId, order_date: isoDay(0), expected_date: isoDay(14),
    lines: [{ item: state.item.id, quantity: "1", uom: state.uoms.BOX, rate: "850", warehouse: rm }],
  });
  await api.dispose();
  await maker.goto(`/procurement/requisitions/${pr2.id}`);
  await maker.getByRole("button", { name: "Cancel requisition" }).click();
  const cancelDialog = maker.getByRole("dialog");
  await expect(cancelDialog.getByRole("button", { name: "Cancel requisition" })).toBeDisabled();
  await cancelDialog.getByLabel("Reason").fill("Raised twice by mistake");
  await cancelDialog.getByRole("button", { name: "Cancel requisition" }).click();
  await expect(maker.getByText("Cancelled", { exact: true }).first()).toBeVisible();
  await expect(maker.getByRole("button", { name: "Submit for approval" })).toHaveCount(0);

  // RFQ from the requisition to two suppliers, two quotations, comparison; the checker's selection creates the PO.
  await maker.goto(requisition);
  await maker.getByRole("link", { name: "Request quotations" }).click();
  await expect(maker.getByLabel("Source")).toContainText("Bearings for CNC line 2");
  await pickCombo(maker, maker.getByLabel("Invite a supplier"), SUPPLIER.code, SUPPLIER.name);
  await pickCombo(maker, maker.getByLabel("Invite a supplier"), SUPPLIER2.code, SUPPLIER2.name);
  const invited = maker.getByRole("list", { name: "Invited suppliers" });
  await expect(invited).toContainText(SUPPLIER.name);
  await expect(invited).toContainText(SUPPLIER2.name);
  await maker.getByRole("button", { name: "Create RFQ" }).click();
  await expect(maker).toHaveURL(/\/procurement\/rfqs\/[0-9a-f-]{36}$/);
  const rfq = maker.url();
  remember("rfq", rfq);
  for (const [supplier, rate, discount, lead, total] of [[SUPPLIER, "850", "2", "7", "₹4165.00"], [SUPPLIER2, "880", "", "5", "₹4400.00"]] as const) {
    await maker.getByRole("button", { name: "Record quotation" }).click();
    const quote = maker.getByRole("dialog");
    await pickSelect(maker, quote.getByLabel("Supplier", { exact: true }), supplier.name);
    await quote.getByLabel("Lead time (days)").fill(lead);
    await quote.getByLabel("Line 1 Rate").fill(rate);
    if (discount) await quote.getByLabel("Line 1 Discount %").fill(discount);
    await expect(quote.getByText(total)).toBeVisible();
    await quote.getByRole("button", { name: "Record quotation" }).click();
    await expect(quote).toHaveCount(0);
  }
  const cheapest = maker.getByRole("row", { name: esc(SUPPLIER.name) });
  await expect(cheapest).toContainText("Cheapest");
  await expect(cheapest).toContainText("4,165.00");
  const dearer = maker.getByRole("row", { name: esc(SUPPLIER2.name) });
  await expect(dearer).toContainText("4,400.00");
  await expect(dearer).not.toContainText("Cheapest");
  await shot(maker, "34-rfq-comparison");

  await checker.goto(rfq);
  await checker.getByRole("row", { name: esc(SUPPLIER.name) }).getByRole("button", { name: "Select" }).click();
  await pickSelect(checker, checker.getByLabel("Deliver to"), /Raw material store/);
  await checker.getByRole("button", { name: "Select and draft PO" }).click();
  await expect(checker).toHaveURL(/\/procurement\/orders\/[0-9a-f-]{36}$/);
  const po = checker.url();
  remember("po", po);

  // PO: GST split is intra-state (Maharashtra to Maharashtra): CGST + SGST.
  await maker.goto(po);
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

  // GRN: 6 boxes against 5 ordered (no tolerance) is refused when the receipt is saved; 5 are received and posted.
  await maker.reload();
  await maker.getByRole("link", { name: "Receive goods" }).click();
  await expect(maker.getByText(/Ordered 5 BOX/)).toBeVisible();
  await maker.getByLabel("Line 1 Receive").fill("6");
  await expect(maker.getByText("Over the order and tolerance")).toBeVisible();
  await maker.getByLabel("Vehicle number").fill("MH14XY0001");
  await maker.getByRole("button", { name: "Save draft receipt" }).click();
  const overAlert = maker.getByRole("alert").filter({ hasText: "receipt exceeds the order" });
  await expect(overAlert).toContainText("open 5");
  await expect(maker).toHaveURL(/\/procurement\/receipts\?/);
  await shot(maker, "36-grn-over-receipt-refused");
  await maker.getByLabel("Line 1 Receive").fill("5");
  await maker.getByRole("button", { name: "Save draft receipt" }).click();
  await expect(maker).toHaveURL(/\/procurement\/receipts\/[0-9a-f-]{36}$/);
  remember("grn", maker.url());
  await maker.getByRole("button", { name: "Post receipt" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /Receipt GRN\// })).toBeVisible();
  const grnRow = maker.getByRole("row", { name: new RegExp(ITEM.code) });
  await expect(grnRow).toContainText("50 NOS"); // 5 boxes of 10 in stock units
  await expect(grnRow).toContainText("Unrestricted");
  await shot(maker, "37-grn-posted");
  await mobileShot(maker, "37-grn-posted");

  // A direct PO to the Karnataka supplier (IGST) for oil seals that need inspection on receipt.
  await maker.goto("/procurement/orders");
  await maker.getByRole("button", { name: "New order" }).click();
  await pickCombo(maker, maker.getByLabel("Supplier", { exact: true }), SUPPLIER2.code, SUPPLIER2.name);
  await pickSelect(maker, maker.getByLabel("Branch"), "Pune works (DEMO)");
  await pickCombo(maker, maker.getByLabel("Line 1 Item"), "E2E-SEAL", new RegExp(SEAL.code));
  await expect(maker.getByLabel("Line 1 Unit")).toContainText("NOS");
  await maker.getByLabel("Line 1 Quantity").fill("100");
  await maker.getByLabel("Line 1 Rate").fill("25");
  await pickSelect(maker, maker.getByLabel("Line 1 Deliver to"), /Raw material store/);
  await expect(maker.getByText("₹2500.00")).toBeVisible();
  await shot(maker, "38-po-direct-new");
  await maker.getByRole("button", { name: "Save draft" }).click();
  await expect(maker).toHaveURL(/\/procurement\/orders\/[0-9a-f-]{36}$/);
  const po2 = maker.url();
  remember("po2", po2);
  await expect(maker.getByText("Inter-state supply: IGST")).toBeVisible();
  await expect(maker.getByRole("row", { name: new RegExp(SEAL.code) })).toContainText("450.00");
  await expect(maker.getByText("₹2,950.00").first()).toBeVisible();
  await maker.getByRole("button", { name: "Submit for approval" }).click();
  await expect(maker.getByText("Submitted", { exact: true }).first()).toBeVisible();
  await checker.goto(po2);
  await checker.getByLabel("Comment").fill("Approved, seals for the Q3 rebuild.");
  await checker.getByRole("button", { name: "Approve" }).click();
  await expect(checker.getByText("Approved", { exact: true }).first()).toBeVisible();

  // Receiving them puts the stock on quality hold.
  await maker.reload();
  await maker.getByRole("link", { name: "Receive goods" }).click();
  await expect(maker.getByText("inspection on receipt")).toBeVisible();
  await expect(maker.getByLabel("Line 1 Receive")).toHaveValue("100");
  await maker.getByLabel("Supplier delivery note").fill("NS/DC/0451");
  await maker.getByRole("button", { name: "Save draft receipt" }).click();
  await expect(maker).toHaveURL(/\/procurement\/receipts\/[0-9a-f-]{36}$/);
  remember("grn2", maker.url());
  await expect(maker.getByText("Will go to quality hold")).toBeVisible();
  await maker.getByRole("button", { name: "Post receipt" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /Receipt GRN\// })).toBeVisible();
  await expect(maker.getByRole("row", { name: new RegExp(SEAL.code) })).toContainText("Quality hold");
  await expect(maker.getByText("Some items need inspection")).toBeVisible();
  await shot(maker, "39-grn-quality-hold");

  // Ten seals failed inspection: return them to the supplier from quality-hold stock.
  await maker.getByRole("link", { name: "Return goods" }).click();
  await expect(maker.getByLabel("Goods receipt")).toContainText(SUPPLIER2.name);
  await expect(maker.getByLabel("Line 1 From stock")).toContainText("Quality hold");
  await maker.getByLabel("Line 1 Return").fill("10");
  await maker.getByLabel("Reason").fill("Lip damaged, failed incoming inspection");
  await maker.getByRole("button", { name: "Save draft return" }).click();
  await expect(maker).toHaveURL(/\/procurement\/receipts\/returns\/[0-9a-f-]{36}$/);
  remember("purchaseReturn", maker.url());
  await maker.getByRole("button", { name: "Post return" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /^Return / })).toBeVisible();
  await expect(maker.getByText("Posted", { exact: true }).first()).toBeVisible();
  await expect(maker.getByRole("row", { name: new RegExp(SEAL.code) })).toContainText("Quality hold");
  await shot(maker, "39b-purchase-return-posted");
  await maker.goto(po2);
  await expect(maker.getByRole("row", { name: new RegExp(SEAL.code) })).toContainText("(−10)");

  // The checker cancels a draft order that is no longer needed.
  await checker.goto(`/procurement/orders/${draftPo.id}`);
  await checker.getByRole("button", { name: "Cancel order" }).click();
  const cancelPo = checker.getByRole("dialog");
  await cancelPo.getByLabel("Reason").fill("Covered by the RFQ order");
  await cancelPo.getByRole("button", { name: "Cancel order" }).click();
  await expect(checker.getByText("Cancelled", { exact: true }).first()).toBeVisible();

  await maker.goto("/procurement/mrp");
  await maker.getByRole("button", { name: "Run now" }).click();
  await expect(maker.getByText(/^Run \d/).first()).toBeVisible();
  await shot(maker, "38-mrp");
  assertMaker();
  assertChecker();
  await maker.context().close();
  await checker.context().close();
});

test("order to invoice: quotation converted, credit block overridden by another user, second order upheld, delivery with COGS, gapless invoice, credit note", async ({ browser }) => {
  test.setTimeout(420_000);
  const state = loadTrade();
  const { customer: CUSTOMER } = names(state.run);
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
  remember("customer", maker.url());
  await expect(maker.getByRole("heading", { level: 1, name: CUSTOMER.name })).toBeVisible();
  await expect(maker.getByText("no customer profile yet")).toHaveCount(0);
  await maker.getByLabel("Credit limit (₹)").fill("1000");
  await maker.getByLabel("Credit days").fill("30");
  await maker.getByRole("button", { name: "Save credit settings" }).click();
  await expect(maker.getByText("Credit settings saved")).toBeVisible();
  await shot(maker, "40-customer-credit");

  // Quotation at agreed prices, converted to an order when the customer accepts.
  await maker.goto("/sales/orders?tab=quotations");
  await maker.getByRole("button", { name: "New quotation" }).click();
  await pickCombo(maker, maker.getByLabel("Customer", { exact: true }), CUSTOMER.code, CUSTOMER.name);
  await pickSelect(maker, maker.getByLabel("Branch"), "Pune works (DEMO)");
  await pickCombo(maker, maker.getByLabel("Line 1 Item"), "E2E-BRG", new RegExp(ITEM.code));
  await maker.getByLabel("Line 1 Quantity").fill("20");
  await maker.getByLabel("Line 1 Rate").fill("150");
  await expect(maker.getByText("₹3000.00")).toBeVisible();
  await shot(maker, "41a-quotation-new");
  await maker.getByRole("button", { name: "Save quotation" }).click();
  await expect(maker).toHaveURL(/\/sales\/orders\/quotations\/[0-9a-f-]{36}$/);
  remember("quotation", maker.url());
  await expect(maker.getByRole("heading", { level: 1, name: /^Quotation / })).toBeVisible();
  await expect(maker.getByText("Inter-state supply: IGST")).toBeVisible();
  await expect(maker.getByText("₹3,540.00").first()).toBeVisible();
  await maker.getByRole("button", { name: "Convert to order" }).click();
  const convert = maker.getByRole("dialog");
  await pickSelect(maker, convert.getByLabel("Ship from"), /Raw material store/);
  await convert.getByRole("button", { name: "Create order" }).click();
  await expect(maker).toHaveURL(/\/sales\/orders\/[0-9a-f-]{36}$/);
  const so = maker.url();
  remember("so", so);

  // Over the credit limit: submit runs the credit check and blocks it.
  await expect(maker.getByText("Inter-state supply: IGST")).toBeVisible();
  await maker.getByRole("button", { name: "Submit order" }).click();
  await expect(maker.getByText("Credit blocked", { exact: true }).first()).toBeVisible();
  await expect(maker.getByText(/exceeds the credit limit/).first()).toBeVisible();
  await expect(maker.getByText("waiting for a credit decision")).toBeVisible();
  await shot(maker, "42-sales-order-credit-blocked");

  // A second order entered directly; its block is upheld by the checker.
  await maker.goto("/sales/orders");
  await maker.getByRole("button", { name: "New order" }).click();
  await pickCombo(maker, maker.getByLabel("Customer", { exact: true }), CUSTOMER.code, CUSTOMER.name);
  await expect(maker.getByLabel("Place of supply")).toContainText("29 · Karnataka");
  await pickSelect(maker, maker.getByLabel("Branch"), "Pune works (DEMO)");
  await pickCombo(maker, maker.getByLabel("Line 1 Item"), "E2E-BRG", new RegExp(ITEM.code));
  await expect(maker.getByLabel("Line 1 Unit")).toContainText("NOS");
  await maker.getByLabel("Line 1 Quantity").fill("8");
  await maker.getByLabel("Line 1 Rate").fill("150");
  await pickSelect(maker, maker.getByLabel("Line 1 Ship from"), /Raw material store/);
  await expect(maker.getByText("₹1200.00")).toBeVisible();
  await shot(maker, "41-sales-order-new");
  await maker.getByRole("button", { name: "Save draft order" }).click();
  await expect(maker).toHaveURL(/\/sales\/orders\/[0-9a-f-]{36}$/);
  const so2 = maker.url();
  remember("so2", so2);
  await maker.getByRole("button", { name: "Submit order" }).click();
  // Only approved orders count towards exposure, so ₹1,416 is over the ₹1,000 limit on its own.
  await expect(maker.getByText("Credit blocked", { exact: true }).first()).toBeVisible();
  await expect(maker.getByText("Exposure 1416.00 exceeds the credit limit 1000.00.").first()).toBeVisible();

  const checker = await userPage(browser, CHECKER, state);
  const assertChecker = watchConsole(checker);
  await checker.goto(so);
  await checker.getByLabel("Reason").fill("Advance of 50% received by bank transfer.");
  await checker.getByRole("button", { name: "Override and approve" }).click();
  await stepUpIfAsked(checker, state, CHECKER, checker.getByText("Credit overridden", { exact: true }));
  await expect(checker.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(checker.getByRole("row", { name: new RegExp(ITEM.code) })).toContainText("20 of 20 NOS"); // reserved
  await shot(checker, "43-sales-order-credit-overridden-reserved");
  await checker.goto(so2);
  await checker.getByLabel("Reason").fill("Exposure too high until the first invoice is paid.");
  await checker.getByRole("button", { name: "Uphold block" }).click();
  await stepUpIfAsked(checker, state, CHECKER, checker.getByText("Rejected", { exact: true }));
  assertChecker();
  await checker.context().close();

  // Delivery from the reserved stock; posting books COGS on the server.
  await maker.goto(so);
  await maker.getByRole("link", { name: "Create delivery" }).click();
  await expect(maker.getByText(/reserved 20/)).toBeVisible();
  await expect(maker.getByLabel("Line 1 Deliver")).toHaveValue("20");
  await maker.getByRole("button", { name: "Save draft delivery" }).click();
  await expect(maker).toHaveURL(/\/sales\/deliveries\/[0-9a-f-]{36}$/);
  remember("delivery", maker.url());
  await maker.getByRole("button", { name: "Post delivery" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /Delivery DN\// })).toBeVisible();
  await expect(maker.getByText(/Cost of goods sold booked on the server: ₹\d/).first()).toBeVisible();
  await shot(maker, "44-delivery-posted");

  // Invoice from delivered quantities; the number is assigned on posting.
  await maker.goto(so);
  await maker.getByRole("link", { name: "Create invoice" }).click();
  await expect(maker.getByText("Will be invoiced")).toBeVisible();
  await maker.getByRole("button", { name: "Create draft invoice" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: "Draft invoice" })).toBeVisible();
  await expect(maker.getByText("assigned from the gapless GST series")).toBeVisible();
  await maker.getByRole("button", { name: "Post invoice" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /Invoice SI\// })).toBeVisible();
  remember("invoice", maker.url());
  await expect(maker.getByText("Inter-state supply: IGST")).toBeVisible();
  await expect(maker.getByText("₹3,540.00").first()).toBeVisible();
  await shot(maker, "45-invoice-posted");
  await mobileShot(maker, "45-invoice-posted");

  // Return of 2 damaged pieces: a credit note with GST reversed.
  await maker.getByRole("link", { name: "Record return" }).click();
  await pickSelect(maker, maker.getByLabel("Return to warehouse"), /Raw material store/);
  await maker.getByLabel("Reason").fill("Two bearings damaged in transit");
  await expect(maker.getByText(new RegExp(`${ITEM.code}.*invoiced 20`))).toBeVisible();
  await maker.getByLabel("Line 1 Return").fill("2");
  await maker.getByLabel("Line 1 Restock").uncheck(); // damaged: to blocked stock
  await maker.getByRole("button", { name: "Save draft return" }).click();
  await expect(maker).toHaveURL(/\/sales\/invoices\/returns\/[0-9a-f-]{36}$/);
  remember("creditNote", maker.url());
  await maker.getByRole("button", { name: "Post and issue credit note" }).click();
  await expect(maker.getByRole("heading", { level: 1, name: /Credit note CN\// })).toBeVisible();
  await expect(maker.getByText("₹354.00")).toBeVisible();
  await expect(maker.getByRole("row", { name: new RegExp(ITEM.code) })).toContainText("Blocked stock");
  await shot(maker, "46-credit-note");
  assertMaker();
  await maker.context().close();
});

test("logistics: vehicles and drivers, expired insurance blocks dispatch, renewal, proof of delivery with an uploaded signature", async ({ browser }) => {
  test.setTimeout(240_000);
  const state = loadTrade();
  const { vehicle: VEHICLE } = names(state.run);
  const maker = await userPage(browser, MAKER);
  const assertMaker = watchConsoleExpecting(maker, [422]);

  await maker.goto("/logistics/shipments?tab=vehicles");
  await maker.getByRole("button", { name: "Add vehicle" }).click();
  let dialog = maker.getByRole("dialog");
  await pickSelect(maker, dialog.getByLabel("Branch"), "Pune works (DEMO)");
  await dialog.getByLabel("Registration").fill(VEHICLE);
  await dialog.getByLabel("Type").fill("Tempo");
  await dialog.getByLabel("Capacity (kg)").fill("1500");
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
  await dialog.getByLabel("Name").fill(`Ramesh Patil ${state.run}`);
  await dialog.getByLabel("Phone").fill("9800000000");
  await dialog.getByLabel("Licence number").fill(`MH12${state.run}0001`);
  await dialog.getByLabel("Licence expires").fill(isoDay(400));
  await dialog.getByRole("button", { name: "Save driver" }).click();
  const driverRow = maker.getByRole("row", { name: esc(`Ramesh Patil ${state.run}`) });
  await expect(driverRow).toBeVisible();
  await maker.getByRole("button", { name: `Edit Ramesh Patil ${state.run}` }).click();
  await maker.getByRole("dialog").getByLabel("Phone").fill("9800000001");
  await maker.getByRole("dialog").getByRole("button", { name: "Save driver" }).click();
  await expect(maker.getByText("Driver updated")).toBeVisible();
  await expect(driverRow).toContainText("9800000001");
  await shot(maker, "50b-drivers");
  await maker.getByRole("tab", { name: "Vehicles" }).click();
  await shot(maker, "50-vehicles-expiry");
  await mobileShot(maker, "50-vehicles-expiry");

  await maker.goto(state.urls.delivery!);
  await maker.getByRole("link", { name: "Plan shipment" }).click();
  await pickSelect(maker, maker.getByLabel("Branch"), "Pune works (DEMO)");
  await pickSelect(maker, maker.getByLabel("Vehicle", { exact: true }), esc(VEHICLE));
  await pickSelect(maker, maker.getByLabel("Driver", { exact: true }), esc(`Ramesh Patil ${state.run}`));
  await maker.getByLabel("Freight cost (₹)").fill("1200");
  await expect(maker.getByRole("status").filter({ hasText: "can't be dispatched" })).toContainText("insurance expired");
  await shot(maker, "51a-shipment-plan");
  await maker.getByRole("button", { name: "Plan shipment" }).click();
  await expect(maker).toHaveURL(/\/logistics\/shipments\/[0-9a-f-]{36}$/);
  const shipment = maker.url();
  remember("shipment", shipment);
  await maker.getByRole("button", { name: "Dispatch" }).click();
  const refused = maker.getByRole("alert").filter({ hasText: "Vehicle or driver documents have expired." });
  await expect(refused).toContainText(new RegExp(`${VEHICLE}: insurance expired on \\d{4}-\\d{2}-\\d{2}`));
  await shot(maker, "51-dispatch-blocked");

  await maker.goto("/logistics/shipments?tab=vehicles");
  await maker.getByRole("button", { name: `Edit ${VEHICLE}` }).click();
  await maker.getByRole("dialog").getByLabel("Insurance expires").fill(isoDay(300));
  await maker.getByRole("dialog").getByRole("button", { name: "Save vehicle" }).click();
  await expect(maker.getByText("Vehicle updated")).toBeVisible();

  await maker.goto(shipment);
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
  test.setTimeout(240_000);
  const state = loadTrade();
  const u = state.urls;
  const maker = await userPage(browser, MAKER);
  const assertClean = watchConsole(maker);
  await maker.setViewportSize({ width: 375, height: 812 });
  const lists: [string, string][] = [
    ["/partners/suppliers", "60-suppliers"], ["/partners/customers", "61-customers"], ["/procurement/requisitions", "62-requisitions"],
    ["/procurement/rfqs", "63-rfqs"], ["/procurement/orders", "64-purchase-orders"], ["/procurement/receipts", "65-receipts"],
    ["/procurement/receipts?tab=returns", "66-purchase-returns"], ["/procurement/mrp", "67-mrp"], ["/sales/orders", "68-sales-orders"],
    ["/sales/orders?tab=quotations", "69-quotations"], ["/sales/deliveries", "70-deliveries"], ["/sales/invoices", "71-invoices"],
    ["/sales/invoices?tab=returns", "72-credit-notes"], ["/logistics/shipments", "73-shipments"], ["/logistics/shipments?tab=drivers", "74-drivers"],
  ];
  const details: [string | undefined, string][] = [
    [u.requisition, "75-requisition-detail"], [u.rfq, "76-rfq-detail"], [u.so, "77-sales-order-detail"], [u.customer, "80-customer-detail"],
    [u.po2, "81-po-igst-detail"], [u.grn2, "82-grn-quality-hold"], [u.purchaseReturn, "83-purchase-return"], [u.quotation, "84-quotation-detail"],
    [u.delivery, "85-delivery-detail"], [u.creditNote, "86-credit-note"], [u.shipment, "87-shipment-detail"],
  ];
  for (const [url, name] of [...lists, ...details]) {
    expect(url, `${name}: made by an earlier test`).toBeTruthy();
    await maker.goto(url!);
    await expect(maker.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(maker.getByLabel("Loading")).toHaveCount(0);
    await expectNoHorizontalScroll(maker);
    await shot(maker, `${name}-375`);
  }
  // Forms in sheets also fit.
  for (const [url, button, name] of [["/procurement/orders", "New order", "78-po-form"], ["/procurement/requisitions", "New requisition", "88-pr-form"],
    ["/sales/orders", "New order", "79-so-form"], ["/logistics/shipments", "Plan shipment", "89-shipment-form"]] as const) {
    await maker.goto(url);
    await maker.getByRole("button", { name: button }).click();
    await expect(maker.getByRole("dialog")).toBeVisible();
    await expectNoHorizontalScroll(maker);
    await shot(maker, `${name}-375`);
  }
  // Desktop list captures.
  await maker.setViewportSize({ width: 1440, height: 900 });
  for (const [url, name] of lists) {
    await maker.goto(url);
    await expect(maker.getByLabel("Loading")).toHaveCount(0);
    await shot(maker, name);
  }
  assertClean();
  await maker.context().close();
});
