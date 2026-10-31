"use client";

import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";

import { api, unwrap } from "./client";
import type { components } from "./schema";

/*
 * Finance and analytics helpers.
 *
 * Money arrives as decimal strings. Nothing here converts money to a float: sums (journal balance,
 * allocation totals) use exact fixed-point BigInt arithmetic at four decimal places, the precision of
 * the ledger, and display formatting works on the digits of the string.
 */

export type Account = components["schemas"]["Account"];
export type CostCenter = components["schemas"]["CostCenter"];
export type PostingRule = components["schemas"]["PostingRule"];
export type JournalEntry = components["schemas"]["JournalEntry"];
export type OpenItem = components["schemas"]["OpenItem"];
export type SupplierInvoice = components["schemas"]["SupplierInvoice"];
export type Payment = components["schemas"]["Payment"];
export type BankAccount = components["schemas"]["CompanyBankAccount"];
export type StatementLine = components["schemas"]["StatementLine"];
export type ReportJob = components["schemas"]["ReportJob"];
export type FiscalYear = components["schemas"]["FiscalYear"];
export type Partner = components["schemas"]["Partner"];

type Dec = string;

// --- Report payloads (the OpenAPI document describes these loosely, so they're typed here) -------

export type TrialBalance = {
  date_from: string;
  date_to: string;
  rows: { account_id: string; code: string; name: string; account_type: string; opening: Dec; debit: Dec; credit: Dec; closing: Dec }[];
  totals: { opening: Dec; debit: Dec; credit: Dec; closing: Dec };
  balanced: boolean;
};
export type StatementRow = { code: string; name: string; amount: Dec };
export type ProfitAndLoss = {
  date_from: string;
  date_to: string;
  income: StatementRow[];
  expenses: StatementRow[];
  total_income: Dec;
  total_expense: Dec;
  net_profit: Dec;
};
export type BalanceSheet = {
  as_of: string;
  sections: { asset: StatementRow[]; liability: StatementRow[]; equity: StatementRow[] };
  totals: { asset: Dec; liability: Dec; equity: Dec };
  balanced: boolean;
};
export type Ledger = {
  account: { id: string; code: string; name: string };
  opening: Dec;
  closing: Dec;
  lines: {
    date: string; number: string; entry_id: string; narration: string; partner: string | null;
    debit: Dec; credit: Dec; balance: Dec; source_type: string; source_id: string | null;
  }[];
};
export const AGEING_BUCKETS = ["Not due", "1–30", "31–60", "61–90", "Over 90"] as const;
export type AgeingRow = { partner_id: string; partner: string; total: Dec } & Record<(typeof AGEING_BUCKETS)[number], Dec>;
export type Reconciliation = {
  book_balance: Dec;
  statement_balance: Dec | null;
  unreconciled_book_items: { id: string; date: string; number: string; amount: Dec; narration: string }[];
  unmatched_statement_lines: number;
};
export type ImportResult = { imported: number; auto_matched: number; batch: string };
type TaxSplit = { cgst: Dec; sgst: Dec; igst: Dec };
export type Gstr1 = {
  b2b: ({ number: string; date: string; place_of_supply: string; taxable: Dec; total: Dec; gstin: string; customer: string } & TaxSplit)[];
  b2c: ({ place_of_supply: string; taxable: Dec } & TaxSplit)[];
  hsn_summary: ({ hsn_code: string | null; gst_rate: Dec; quantity: Dec; taxable: Dec } & TaxSplit)[];
  credit_notes: { number: string; date: string; invoice: string; total: Dec }[];
};
export type Gstr3b = {
  outward_taxable: Dec;
  output_tax: TaxSplit;
  credit_notes_total: Dec;
  input_tax_credit: TaxSplit;
  net_payable: TaxSplit;
  carry_forward_credit: TaxSplit;
};
export type SubledgerCheck = { check: string; subledger: Dec; gl: Dec; difference: Dec; ok: boolean };
export type BudgetVsActualRow = { account: string; name: string; cost_center_id: string | null; planned: Dec; actual: Dec; variance: Dec };

export type WidgetUnit = "inr" | "days" | "pct" | "ratio" | "count";
export type Widget = { key: string; label: string; unit: WidgetUnit; value: Dec | number | null } & Record<string, unknown>;
export type Dashboard = {
  dashboard: string;
  date_from: string;
  date_to: string;
  widgets: Widget[];
  hidden: { key: string; label: string; needs: string }[];
};
export type Forecast = {
  item: { id: string; code: string; name: string };
  method: "moving_average" | "exponential_smoothing";
  parameters: Record<string, string | number>;
  history: { month: string; demand: Dec }[];
  forecast: { month: string; demand: Dec }[];
  mad: Dec | null;
  observations: number;
};
export type ReportType = { code: string; label: string; params: string[] };

// --- Exact decimal arithmetic ----------------------------------------------------------------

const SCALE = 4;

/** Parses a decimal string into fixed-point units (1 unit = 0.0001). Invalid input parses as 0. */
export function toUnits(value: Dec | number | null | undefined): bigint {
  if (value === null || value === undefined) return BigInt(0);
  const text = String(value).trim();
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (!match[2] && !match[3])) return BigInt(0);
  const [, sign, whole = "", frac = ""] = match;
  const digits = BigInt((whole || "0") + frac.padEnd(SCALE, "0").slice(0, SCALE));
  return sign === "-" ? -digits : digits;
}

/** Formats fixed-point units back into a plain decimal string with `dp` places (half-up rounding). */
export function fromUnits(units: bigint, dp = 2): string {
  const negative = units < BigInt(0);
  let abs = negative ? -units : units;
  const drop = SCALE - dp;
  if (drop > 0) {
    const div = BigInt(10 ** drop);
    abs = (abs + div / BigInt(2)) / div;
  }
  const base = BigInt(10 ** dp);
  const whole = (abs / base).toString();
  const frac = dp > 0 ? `.${(abs % base).toString().padStart(dp, "0")}` : "";
  return `${negative && abs !== BigInt(0) ? "-" : ""}${whole}${frac}`;
}

export function sumDecimals(values: (Dec | number | null | undefined)[]): string {
  return fromUnits(values.reduce<bigint>((acc, v) => acc + toUnits(v), BigInt(0)), 4);
}

export const isZero = (value: Dec | number | null | undefined) => toUnits(value) === BigInt(0);
export const isNegative = (value: Dec | number | null | undefined) => toUnits(value) < BigInt(0);
export const absDecimal = (value: Dec | number | null | undefined) => {
  const u = toUnits(value);
  return fromUnits(u < BigInt(0) ? -u : u, 4);
};

/** A user-entered amount: digits with at most four decimals, and more than zero. */
export function isPositiveAmount(text: string): boolean {
  return /^\d+(\.\d{1,4})?$/.test(text.trim()) && toUnits(text) > BigInt(0);
}

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last}`;
}

/** Formats a decimal string with Indian grouping (lakh/crore) without converting it to a float. */
export function formatDecimal(value: Dec | number | null | undefined, { dp = 2, currency = false, sign = true } = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  const fixed = fromUnits(toUnits(value), dp);
  const negative = fixed.startsWith("-");
  const [whole, frac] = (negative ? fixed.slice(1) : fixed).split(".");
  const body = `${currency ? "₹" : ""}${groupIndian(whole)}${frac ? `.${frac}` : ""}`;
  return negative && sign ? `−${body}` : body; // U+2212: a real minus sign, legible at small sizes
}

// --- Dates ------------------------------------------------------------------------------------

export const isoDate = (d: Date) => format(d, "yyyy-MM-dd");
export const today = () => isoDate(new Date());
export function monthStart(d = new Date()) {
  return isoDate(new Date(d.getFullYear(), d.getMonth(), 1));
}
/** Indian fiscal year (April–March) containing the date. */
export function fiscalYearStart(d = new Date()) {
  const year = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return isoDate(new Date(year, 3, 1));
}

// --- Shared lookups ---------------------------------------------------------------------------

export function useAccounts(enabled = true) {
  return useQuery({
    queryKey: ["finance", "accounts"],
    queryFn: () => unwrap(api.GET("/api/v1/finance/accounts/", { params: { query: { ordering: "code" } } })),
    staleTime: 60_000,
    enabled,
  });
}

/** Leaf accounts that can receive postings. */
export function postable(accounts: Account[] | undefined): Account[] {
  return (accounts ?? []).filter((a) => !a.is_group && a.is_active !== false);
}

export function useCostCenters(enabled = true) {
  return useQuery({
    queryKey: ["finance", "cost-centers"],
    queryFn: () => unwrap(api.GET("/api/v1/finance/cost-centers/", { params: { query: { page_size: 200, ordering: "code" } } })),
    staleTime: 60_000,
    enabled,
  });
}

export function useBankAccounts(enabled = true) {
  return useQuery({
    queryKey: ["finance", "bank-accounts"],
    queryFn: () => unwrap(api.GET("/api/v1/finance/bank-accounts/", { params: { query: { page_size: 100 } } })),
    enabled,
  });
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  posted: "Posted",
  cancelled: "Cancelled",
};

export const MODE_LABEL: Record<string, string> = {
  neft: "NEFT", rtgs: "RTGS", imps: "IMPS", upi: "UPI", cheque: "Cheque", cash: "Cash",
};
