"use client";

import { AlertTriangle } from "lucide-react";

import { isApiError } from "@/lib/api/errors";
import { formatDecimal } from "@/lib/api/finance";

type Issue = { item?: string; issue?: string; billed?: string; received_open?: string; ordered_open?: string; detail?: string;
  po_rate?: string; billed_rate?: string; difference?: string };
type Check = { check: string; subledger: string; gl: string; difference: string; ok: boolean };

const ISSUE_TEXT: Record<string, (i: Issue) => string> = {
  quantity: (i) => `${i.item}: billed ${i.billed}, but only ${i.received_open ?? i.ordered_open} is open to invoice.`,
  no_receipt: (i) => `${i.item}: ${i.detail ?? "needs a goods receipt."}`,
  price: (i) => `${i.item}: billed rate ${i.billed_rate} vs order rate ${i.po_rate} (difference ${formatDecimal(i.difference)}).`,
};

/** Human copy for errors whose server message is deliberately generic. */
function explain(error: unknown, context?: { forbidden?: string }): string {
  if (!isApiError(error)) return "The server couldn't be reached. Check your connection and try again.";
  if (error.type === "version_conflict") return "Someone else changed this while you were looking at it. It has been reloaded; check it and try again.";
  if (error.type === "permission_denied") return context?.forbidden ?? `${error.problem.detail} Another person may need to do this step.`;
  if (error.type === "mfa_required") return "This needs a fresh two-step verification. Try again and enter your code.";
  return error.summary();
}

/** Shows the API's problem detail beside the action that caused it, including structured details. */
export function ActionError({ error, forbidden, className = "" }: { error: unknown; forbidden?: string; className?: string }) {
  if (!error) return null;
  const meta = isApiError(error) ? error.problem.meta : undefined;
  const issues = (meta?.issues as Issue[] | undefined) ?? [];
  const checks = (meta?.checks as Check[] | undefined) ?? [];
  const fieldErrors = isApiError(error) ? (error.problem.errors ?? []).slice(1) : [];
  return (
    <div role="alert" className={`flex gap-2.5 rounded-md border border-status-rejected/30 bg-status-rejected/10 px-3 py-2.5 text-sm ${className}`}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-rejected" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-status-rejected">{explain(error, { forbidden })}</p>
        {fieldErrors.length > 0 && (
          <ul className="list-disc pl-4 text-foreground/80">
            {fieldErrors.map((e, i) => <li key={i}>{e.field ? `${e.field}: ` : ""}{e.message}</li>)}
          </ul>
        )}
        {issues.length > 0 && (
          <ul className="list-disc pl-4 text-foreground/80">
            {issues.map((i, n) => <li key={n}>{ISSUE_TEXT[i.issue ?? ""]?.(i) ?? JSON.stringify(i)}</li>)}
          </ul>
        )}
        {checks.length > 0 && (
          <ul className="list-disc pl-4 text-foreground/80">
            {checks.filter((c) => !c.ok).map((c) => (
              <li key={c.check}>{c.check}: sub-ledger {formatDecimal(c.subledger, { currency: true })} vs ledger {formatDecimal(c.gl, { currency: true })}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
