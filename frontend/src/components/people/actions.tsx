"use client";

import { CheckCircle2, Landmark, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Field, FormError } from "@/components/erp/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { idempotencyKey } from "@/lib/api/client";
import { errorText, humanize, type RowError, today } from "@/lib/api/people";

/** Approve or reject with a comment (a reason is required to reject). */
export function DecideDialog({ title, description, onDecide, pending, error, blockedReason, triggerLabel = "Decide" }: {
  title: string;
  description?: ReactNode;
  onDecide: (approve: boolean, comment: string) => Promise<unknown>;
  pending?: boolean;
  error?: unknown;
  /** Shown instead of the decision buttons (e.g. it's the caller's own request). */
  blockedReason?: string;
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const decide = async (approve: boolean) => {
    try {
      await onDecide(approve, comment);
      setOpen(false);
      setComment("");
    } catch {
      /* error shown in the dialog */
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">{triggerLabel}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription asChild><div>{description}</div></DialogDescription>}
        </DialogHeader>
        {blockedReason ? (
          <p role="alert" className="rounded-md border border-status-pending/30 bg-status-pending/10 px-3 py-2 text-sm text-status-pending">{blockedReason}</p>
        ) : (
          <>
            <FormError message={error ? errorText(error) : undefined} />
            <Field id="decision-comment" label="Comment" hint="Required when rejecting. The requester sees it.">
              <Textarea id="decision-comment" value={comment} onChange={(e) => setComment(e.target.value)} rows={3} />
            </Field>
            <DialogFooter className="gap-2">
              <Button variant="outline" disabled={pending || !comment.trim()} onClick={() => decide(false)}>
                <XCircle aria-hidden /> Reject
              </Button>
              <Button disabled={pending} onClick={() => decide(true)}>
                <CheckCircle2 aria-hidden /> Approve
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Record a bank payment. The Idempotency-Key is created when the dialog opens and reused for
 * retries of the same action, so a double click or a step-up retry can't pay twice.
 */
export function PayDialog({ title, description, onPay, pending, error, blockedReason }: {
  title: string;
  description?: ReactNode;
  onPay: (body: { paid_on: string; bank_reference: string }, key: string) => Promise<unknown>;
  pending?: boolean;
  error?: unknown;
  blockedReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [paidOn, setPaidOn] = useState(today);
  const [reference, setReference] = useState("");
  const [key, setKey] = useState(idempotencyKey);
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setKey(idempotencyKey()); }}>
      <DialogTrigger asChild>
        <Button size="sm"><Landmark aria-hidden /> Record payment</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await onPay({ paid_on: paidOn, bank_reference: reference.trim() }, key);
              setOpen(false);
              setReference("");
            } catch {
              /* shown below */
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription asChild><div>{description}</div></DialogDescription>}
          </DialogHeader>
          {blockedReason ? (
            <p role="alert" className="rounded-md border border-status-pending/30 bg-status-pending/10 px-3 py-2 text-sm text-status-pending">{blockedReason}</p>
          ) : (
            <>
              <FormError message={error ? errorText(error) : undefined} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="paid-on" label="Paid on"><Input id="paid-on" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required /></Field>
                <Field id="bank-reference" label="Bank reference"><Input id="bank-reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} required /></Field>
              </div>
              <DialogFooter><Button type="submit" disabled={pending || !reference.trim()}>Record payment</Button></DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Row- or line-level errors returned in `meta.errors`. */
export function RowErrorList({ errors, unit = "Row" }: { errors: RowError[]; unit?: "Row" | "Line" }) {
  if (errors.length === 0) return null;
  return (
    <div role="alert" className="max-h-64 overflow-auto rounded-md border border-status-rejected/30 bg-status-rejected/5">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-status-rejected/20 text-left text-xs text-muted-foreground">
            <th className="px-3 py-1.5 font-medium">{unit}</th>
            <th className="px-3 py-1.5 font-medium">Field</th>
            <th className="px-3 py-1.5 font-medium">Problem</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((e, i) => (
            <tr key={i} className="border-b border-status-rejected/10 last:border-0">
              <td className="num px-3 py-1.5">{e.row ?? e.line ?? "—"}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{e.field ? humanize(e.field) : "—"}</td>
              <td className="px-3 py-1.5 text-status-rejected">{e.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Label/value pairs that stack on phones. */
export function Facts({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 px-5 py-4 text-sm">
      {items.map(([label, value], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Horizontal tab strip that scrolls inside itself on narrow screens instead of widening the page. */
export function TabStrip({ children }: { children: ReactNode }) {
  return <div className="-mx-1 mb-4 max-w-full overflow-x-auto px-1 pb-1">{children}</div>;
}
