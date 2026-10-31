"use client";

import { AlertTriangle, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

import { StatusBadge, type Tone } from "@/components/erp/status";
import { isApiError } from "@/lib/api/errors";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

import { add, dec0, fixed } from "./decimal";

const TONES: Record<string, Tone> = {
  draft: "neutral",
  submitted: "pending",
  approved: "approved",
  rejected: "rejected",
  cancelled: "neutral",
  closed: "neutral",
  posted: "approved",
  open: "info",
  accepted: "approved",
  lost: "neutral",
  expired: "neutral",
  selected: "approved",
  not_selected: "neutral",
  planned: "info",
  dispatched: "pending",
  delivered: "approved",
  partially_delivered: "pending",
  partial: "pending",
  refused: "rejected",
  partially_received: "pending",
  received: "approved",
  pending_verification: "pending",
  verified: "approved",
  retired: "neutral",
  // credit check
  pending: "neutral",
  ok: "approved",
  blocked: "rejected",
  overridden: "info",
  converted: "approved",
  dismissed: "neutral",
};

const LABELS: Record<string, string> = {
  pending_verification: "Pending verification",
  partially_delivered: "Partially delivered",
  partially_received: "Partially received",
  not_selected: "Not selected",
  ok: "Credit OK",
  blocked: "Credit blocked",
  overridden: "Credit overridden",
};

export function humanize(value: string): string {
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function DocStatus({ status, label }: { status: string; label?: string }) {
  return <StatusBadge tone={TONES[status] ?? "neutral"}>{label ?? LABELS[status] ?? humanize(status)}</StatusBadge>;
}

export function CreditStatus({ status }: { status: string }) {
  if (status === "pending") return <StatusBadge tone="neutral">Credit not checked</StatusBadge>;
  return <DocStatus status={status} />;
}

/** 403 codes the API explains (a control on the caller's own action), with a readable detail. */
const EXPLAINED_DENIALS = new Set(["self_approval", "maker_checker", "approval_limit", "sod"]);

/**
 * Copy for denials. `permission_denied` covers the generic ones the API keeps vague (the reason is logged
 * server side); a code such as `maker_checker` overrides the server's explanation for that control.
 */
export type DenialHints = Partial<Record<"permission_denied" | "not_found" | string, string>>;

/** Shows the API's problem detail (business rule code, field errors, listed problems) next to an action. */
export function ActionError({ error, hints, className }: { error: unknown; hints?: DenialHints; className?: string }) {
  if (!error) return null;
  let title = "Couldn't reach the server.";
  let items: string[] = [];
  let code: string | undefined;
  if (isApiError(error)) {
    const p = error.problem;
    code = p.code && p.code !== p.type ? p.code : undefined;
    if (p.type === "version_conflict") {
      title = "Someone changed this record while you were working. The latest version is now shown; check it and try again.";
    } else if (p.type === "permission_denied" && code && EXPLAINED_DENIALS.has(code)) {
      // The server names the control that stopped the caller (maker-checker, self-approval, limit, SoD).
      title = hints?.[code] ?? p.detail;
      code = undefined;
    } else if (hints?.[p.type]) {
      title = hints[p.type]!;
    } else if (p.type === "permission_denied") {
      title = "You can't do this. You may lack the permission for this record, or a control (maker-checker, approval limit) applies.";
    } else if (p.type === "mfa_required") {
      title = "This action needs a fresh two-step verification.";
    } else {
      title = p.errors?.length ? p.detail : p.detail;
    }
    items = (p.errors ?? []).map((e) => (e.field && e.field !== "_form" ? `${e.field.replace(/_/g, " ")}: ${e.message}` : e.message));
    const problems = p.meta?.problems;
    if (Array.isArray(problems)) items.push(...problems.map(String));
    if (typeof p.meta?.open === "string") items.push(`Still open on that line: ${p.meta.open}`);
  }
  return (
    <div role="alert" className={cn("rounded-md border border-status-rejected/30 bg-status-rejected/10 px-3 py-2 text-sm text-status-rejected", className)}>
      <p className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{title}</span>
      </p>
      {items.length > 0 && (
        <ul className="mt-1.5 ml-6 list-disc space-y-0.5">
          {items.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      )}
      {code && <p className="mt-1 ml-6 font-mono text-xs opacity-80">{code}</p>}
    </div>
  );
}

/** Explains a control that applies to the current user (maker-checker, credit, holds). */
export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "pending" | "rejected" }) {
  const toneClass = {
    info: "border-status-info/25 bg-status-info/10 text-status-info",
    pending: "border-status-pending/25 bg-status-pending/10 text-status-pending",
    rejected: "border-status-rejected/25 bg-status-rejected/10 text-status-rejected",
  }[tone];
  return (
    <p className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm", toneClass)}>
      <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** Label/value pairs, two columns on wide screens. */
export function Facts({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-6 gap-y-2 px-5 py-4 text-sm sm:grid-cols-[minmax(7rem,auto)_minmax(0,1fr)_minmax(7rem,auto)_minmax(0,1fr)]", className)}>
      {items.map(([label, value], i) => (
        <span key={i} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </span>
      ))}
    </dl>
  );
}

/** Sums API decimal strings exactly (no floats). */
export function sumOf<T>(rows: T[] | undefined, pick: (row: T) => string | null | undefined): string {
  return fixed(add(...(rows ?? []).map((r) => dec0(pick(r)))), 2);
}

/** Totals block: API values only. */
export function Totals({ rows, total, note }: { rows: [string, string | null | undefined][]; total: [string, string | null | undefined]; note?: ReactNode }) {
  return (
    <div className="flex flex-col items-end gap-1 border-t px-5 py-4 text-sm">
      <dl className="grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1">
        {rows.map(([label, value]) => (
          <span key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="num text-right">{money(value)}</dd>
          </span>
        ))}
        <dt className="border-t pt-1.5 font-semibold">{total[0]}</dt>
        <dd className="num border-t pt-1.5 text-right text-base font-semibold">{money(total[1])}</dd>
      </dl>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

export function GstMode({ intra }: { intra: boolean }) {
  return (
    <span className="text-muted-foreground">
      {intra ? "Intra-state supply: CGST + SGST" : "Inter-state supply: IGST"}
    </span>
  );
}

export function today(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Days from today until an ISO date (negative when past). */
export function daysUntil(isoDate: string | null | undefined): number | null {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  const now = new Date();
  const base = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - base) / 86_400_000);
}

/** Expiry date with ISO 3864 colouring: red when expired, amber within 30 days. */
export function ExpiryDate({ value }: { value: string | null | undefined }) {
  const days = daysUntil(value);
  if (!value || days === null) return <span className="text-muted-foreground">—</span>;
  const tone = days < 0 ? "rejected" : days <= 30 ? "pending" : null;
  const label = new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  if (!tone) return <span className="num">{label}</span>;
  return <StatusBadge tone={tone}>{days < 0 ? `Expired ${label}` : `${label} (${days}d)`}</StatusBadge>;
}

export function Money({ value }: { value: string | null | undefined }) {
  return <span className="num">{money(value)}</span>;
}
