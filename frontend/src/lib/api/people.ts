"use client";

import { useQuery } from "@tanstack/react-query";

import { api, unwrap } from "./client";
import { isApiError } from "./errors";
import type { components } from "./schema";

/* HR, payroll and expenses: types, query hooks and money helpers shared by the People screens. */

type S = components["schemas"];

export type Employee = S["Employee"];
export type Department = S["Department"];
export type Attendance = S["Attendance"];
export type LeaveType = S["LeaveType"];
export type LeaveBalance = S["LeaveBalance"];
export type LeaveRequest = S["LeaveRequest"];
export type SalaryComponent = S["SalaryComponent"];
export type SalaryStructure = S["SalaryStructure"];
export type EmployeeSalary = S["EmployeeSalary"];
export type Category = S["Category"];
export type Claim = S["Claim"];
export type ClaimLine = S["ClaimLine"];
export type ClaimLineRequest = S["ClaimLineRequest"];
export type Advance = S["Advance"];
export type FuelLog = S["FuelLog"];
export type PayslipLine = S["PayslipLine"];

/**
 * The API omits salary amounts for callers without `hr.salary.read` (and for payslips that aren't
 * the caller's own). The OpenAPI schema still marks them required, so model them as optional: an
 * absent amount must render as "restricted", never as zero.
 */
type RunAmountKey = "gross_total" | "deduction_total" | "employer_total" | "net_total" | "amount";
export type PayrollRun = Omit<S["PayrollRun"], RunAmountKey> & Partial<Pick<S["PayrollRun"], RunAmountKey>>;
type SlipAmountKey = "gross" | "total_deductions" | "employer_contributions" | "net_pay" | "lines";
export type Payslip = Omit<S["Payslip"], SlipAmountKey> & Partial<Pick<S["Payslip"], SlipAmountKey>>;

/** Salary data must not outlive the screen that asked for it. */
export const SENSITIVE_QUERY = { gcTime: 0, staleTime: 0 } as const;

// --- Query hooks ------------------------------------------------------------------------------------

/** The caller's own employee record; `null` when no employee is linked to the account. */
export function useMyEmployee() {
  return useQuery({
    queryKey: ["people", "my", "profile"],
    queryFn: async () => {
      try {
        return await unwrap(api.GET("/api/v1/hr/my/profile/"));
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function useDepartments(enabled = true) {
  return useQuery({
    queryKey: ["people", "departments"],
    queryFn: () => unwrap(api.GET("/api/v1/organization/departments/", { params: { query: { is_active: true, page_size: 200 } } })),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useLeaveTypes(enabled = true) {
  return useQuery({
    queryKey: ["people", "leave-types"],
    queryFn: () => unwrap(api.GET("/api/v1/hr/leave-types/", { params: { query: { page_size: 200 } } })),
    enabled,
  });
}

export function useCategories(enabled = true) {
  return useQuery({
    queryKey: ["people", "expense-categories"],
    queryFn: () => unwrap(api.GET("/api/v1/expenses/categories/", { params: { query: { page_size: 200 } } })),
    enabled,
  });
}

/** The caller's own advances (self-service), newest first. */
export function useMyAdvances(enabled = true) {
  return useQuery({
    queryKey: ["people", "my", "advances"],
    queryFn: () => unwrap(api.GET("/api/v1/expenses/my/advances/")),
    enabled,
  });
}

export function useSalaryComponents(enabled = true) {
  return useQuery({
    queryKey: ["people", "salary-components"],
    queryFn: () => unwrap(api.GET("/api/v1/hr/salary-components/", { params: { query: { page_size: 200 } } })),
    enabled,
  });
}

export function useSalaryStructures(enabled = true) {
  return useQuery({
    queryKey: ["people", "salary-structures"],
    queryFn: () => unwrap(api.GET("/api/v1/hr/salary-structures/", { params: { query: { page_size: 200 } } })),
    enabled,
  });
}

// --- Errors -------------------------------------------------------------------------------------------

export type RowError = { row?: number | null; line?: number | null; field?: string | null; message: string };

/** 403 refusal codes whose `detail` explains the control (self-approval, maker-checker, limit, SoD). */
export const EXPLAINED_REFUSALS = new Set(["self_approval", "maker_checker", "approval_limit", "sod"]);

/** The refusal code of a 403 that explains a control on the caller's own action, if any. */
export function refusalCode(error: unknown): string | null {
  if (!isApiError(error) || error.status !== 403) return null;
  const code = error.problem.code;
  return code && EXPLAINED_REFUSALS.has(code) ? code : null;
}

/** One readable line for a failed mutation, with a clear message for edit conflicts. */
export function errorText(error: unknown): string {
  if (!isApiError(error)) return "Couldn't reach the server. Check your connection.";
  if (error.type === "version_conflict") return "Someone else changed this record. The latest version is loaded; check it and try again.";
  if (error.type === "mfa_required") return "This needs a fresh two-step verification.";
  // Controls on the caller's own action come back with a code and a readable reason: show it.
  if (error.status === 403 && error.problem.code && EXPLAINED_REFUSALS.has(error.problem.code)) return error.problem.detail;
  if (error.status === 403) return "You can't do this. The server refused: you may lack the permission for it.";
  return error.summary();
}

/** Per-row / per-line errors carried in `meta.errors` (attendance import, expense policy). */
export function rowErrors(error: unknown): RowError[] {
  if (!isApiError(error)) return [];
  const list = error.problem.meta?.errors;
  return Array.isArray(list) ? (list as RowError[]) : [];
}

// --- Money and quantities (decimal strings; never float arithmetic) ------------------------------------------

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** True for a non-negative amount with at most two decimals ("1250", "99.5", "0.75"). */
export function isMoney(value: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(value.trim());
}

/** Decimal string → integer of minor units at `scale` decimals (truncates extra digits). */
function toMinor(value: string, scale = 2): bigint {
  const v = value.trim();
  if (!DECIMAL.test(v)) return BigInt(0);
  const negative = v.startsWith("-");
  const [whole, frac = ""] = v.replace("-", "").split(".");
  const digits = `${whole}${frac.padEnd(scale, "0").slice(0, scale)}`;
  const n = BigInt(digits || "0");
  return negative ? -n : n;
}

function fromMinor(n: bigint, scale = 2): string {
  const negative = n < BigInt(0);
  const s = (negative ? -n : n).toString().padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

/** Exact sum of decimal strings (invalid entries count as zero). */
export function sumMoney(values: (string | null | undefined)[]): string {
  return fromMinor(values.reduce<bigint>((acc, v) => acc + (v ? toMinor(v) : BigInt(0)), BigInt(0)));
}

/** Exact comparison of two decimal strings: -1, 0 or 1. */
export function compareDecimal(a: string, b: string, scale = 4): number {
  const x = toMinor(a, scale);
  const y = toMinor(b, scale);
  return x === y ? 0 : x > y ? 1 : -1;
}

/** "12.50" → "12.5", "3.00" → "3" (string trimming only). */
export function trimDecimal(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * An API amount (NUMERIC(20,4), e.g. "1200.0000") as an editable input value ("1200"), so forms that
 * accept at most two decimals don't reject untouched values.
 */
export function moneyInput(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "" : trimDecimal(value);
}

/** Today in the browser's local calendar as YYYY-MM-DD. */
export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function periodLabel(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

/** First and last day (YYYY-MM-DD) of a YYYY-MM period. */
export function monthRange(period: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const last = new Date(year, month, 0).getDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}` };
}

export function humanize(value: string): string {
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Master-data PATCH endpoints read `version` for optimistic locking, but their OpenAPI request
 * schemas don't declare it. Attach it explicitly (and visibly) here.
 */
export function withVersion<T extends object>(body: T, version: number): T {
  return { ...body, version } as T;
}
