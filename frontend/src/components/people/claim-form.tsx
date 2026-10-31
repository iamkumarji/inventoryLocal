"use client";

import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { Field } from "@/components/erp/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { compareDecimal, isMoney, moneyInput, sumMoney, today, trimDecimal, useMyAdvances, type Advance, type Category, type ClaimLine, type ClaimLineRequest } from "@/lib/api/people";
import { money } from "@/lib/format";

export type LineDraft = {
  key: string;
  category: string;
  expense_date: string;
  description: string;
  amount: string;
  receipt_reference: string;
  vehicle_registration: string;
  odometer: string;
  litres: string;
};

let seq = 0;
export function blankLine(): LineDraft {
  seq += 1;
  return { key: `new-${seq}`, category: "", expense_date: today(), description: "", amount: "", receipt_reference: "", vehicle_registration: "", odometer: "", litres: "" };
}

export function lineFromApi(l: ClaimLine): LineDraft {
  return {
    key: l.id,
    category: l.category,
    expense_date: l.expense_date,
    description: l.description,
    amount: moneyInput(l.amount),
    receipt_reference: l.receipt_reference ?? "",
    vehicle_registration: l.vehicle_registration ?? "",
    odometer: l.odometer ? trimDecimal(l.odometer) : "",
    litres: l.litres ? trimDecimal(l.litres) : "",
  };
}

export function lineToApi(l: LineDraft, vehicle: boolean): ClaimLineRequest {
  return {
    category: l.category,
    expense_date: l.expense_date,
    description: l.description.trim(),
    amount: l.amount.trim(),
    receipt_reference: l.receipt_reference.trim(),
    vehicle_registration: vehicle ? l.vehicle_registration.trim() : "",
    odometer: vehicle && l.odometer.trim() ? l.odometer.trim() : null,
    litres: vehicle && l.litres.trim() ? l.litres.trim() : null,
  };
}

/** Policy hints computed from category data (the server re-checks everything on submit). */
export function lineHints(lines: LineDraft[], categories: Category[]) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const perLine = lines.map((l) => {
    const c = byId.get(l.category);
    const hints: string[] = [];
    if (l.amount && !isMoney(l.amount)) hints.push("Enter an amount like 1250 or 1250.50.");
    if (c?.receipt_required_above && isMoney(l.amount) && compareDecimal(l.amount, c.receipt_required_above) > 0 && !l.receipt_reference.trim()) {
      hints.push(`Above ${money(c.receipt_required_above)} needs a receipt.`);
    }
    if (c?.requires_vehicle && (!l.vehicle_registration.trim() || !l.odometer.trim() || !l.litres.trim())) hints.push("Fuel needs vehicle, odometer and litres.");
    if (l.expense_date > today()) hints.push("The date is in the future.");
    return hints;
  });
  const overall: string[] = [];
  for (const c of categories) {
    if (!c.per_claim_limit) continue;
    const total = sumMoney(lines.filter((l) => l.category === c.id && isMoney(l.amount)).map((l) => l.amount));
    if (compareDecimal(total, c.per_claim_limit) > 0) overall.push(`${c.name} totals ${money(total)}, above the per-claim limit of ${money(c.per_claim_limit)}.`);
  }
  return { perLine, overall };
}

/** Mobile-first line editor: one card per expense. */
export function ClaimLinesEditor({ lines, onChange, categories, errorsByLine, lineExtra }: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  categories: Category[];
  errorsByLine?: Record<number, string[]>;
  /** Extra controls per line (e.g. attaching a receipt file); receives a setter for that line. */
  lineExtra?: (line: LineDraft, update: (patch: Partial<LineDraft>) => void) => ReactNode;
}) {
  const active = categories.filter((c) => c.is_active ?? true);
  const { perLine, overall } = lineHints(lines, categories);
  const update = (i: number, patch: Partial<LineDraft>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="grid gap-3">
      {lines.map((l, i) => {
        const category = categories.find((c) => c.id === l.category);
        const id = (f: string) => `line-${i}-${f}`;
        const messages = [...perLine[i], ...(errorsByLine?.[i + 1] ?? [])];
        return (
          <fieldset key={l.key} className="grid gap-3 rounded-lg border bg-card p-3 sm:p-4">
            <div className="flex items-center justify-between">
              <legend className="text-sm font-medium">Expense {i + 1}</legend>
              {lines.length > 1 && (
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(lines.filter((_, j) => j !== i))} aria-label={`Remove expense ${i + 1}`}>
                  <Trash2 aria-hidden />
                </Button>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={id("category")} label="Category">
                <Select value={l.category} onValueChange={(v) => update(i, { category: v })}>
                  <SelectTrigger id={id("category")} className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
                  <SelectContent>{active.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field id={id("date")} label="Date"><Input id={id("date")} type="date" max={today()} value={l.expense_date} onChange={(e) => update(i, { expense_date: e.target.value })} required /></Field>
              <Field id={id("description")} label="What for" className="sm:col-span-2"><Input id={id("description")} value={l.description} maxLength={300} onChange={(e) => update(i, { description: e.target.value })} required /></Field>
              <Field id={id("amount")} label="Amount (₹)"><Input id={id("amount")} inputMode="decimal" className="num" value={l.amount} onChange={(e) => update(i, { amount: e.target.value })} required /></Field>
              <Field id={id("receipt")} label="Receipt" hint={category?.receipt_required_above ? `Required above ${money(category.receipt_required_above)}` : "Bill number or document reference"}>
                <Input id={id("receipt")} value={l.receipt_reference} maxLength={100} onChange={(e) => update(i, { receipt_reference: e.target.value })} />
              </Field>
              {category?.requires_vehicle && (
                <>
                  <Field id={id("vehicle")} label="Vehicle registration"><Input id={id("vehicle")} value={l.vehicle_registration} maxLength={20} className="uppercase" onChange={(e) => update(i, { vehicle_registration: e.target.value })} /></Field>
                  <Field id={id("odometer")} label="Odometer (km)"><Input id={id("odometer")} inputMode="decimal" value={l.odometer} onChange={(e) => update(i, { odometer: e.target.value })} /></Field>
                  <Field id={id("litres")} label="Litres"><Input id={id("litres")} inputMode="decimal" value={l.litres} onChange={(e) => update(i, { litres: e.target.value })} /></Field>
                </>
              )}
            </div>
            {lineExtra && <div>{lineExtra(l, (patch) => update(i, patch))}</div>}
            {messages.length > 0 && (
              <ul className="grid gap-0.5 text-sm text-status-pending">{messages.map((m) => <li key={m}>{m}</li>)}</ul>
            )}
          </fieldset>
        );
      })}
      <Button type="button" variant="outline" onClick={() => onChange([...lines, blankLine()])} className="justify-self-start">
        <Plus aria-hidden /> Add another expense
      </Button>
      {overall.length > 0 && <ul className="grid gap-0.5 text-sm text-status-pending">{overall.map((m) => <li key={m}>{m}</li>)}</ul>}
      <p className="flex items-baseline justify-between border-t pt-3 text-sm">
        <span className="text-muted-foreground">Total</span>
        <span className="num text-lg font-semibold">{money(sumMoney(lines.filter((l) => isMoney(l.amount)).map((l) => l.amount)))}</span>
      </p>
    </div>
  );
}

/** Paid advances with money still outstanding: the ones a claim can settle. */
export function openAdvances(advances: Advance[] | undefined, keep?: string | null): Advance[] {
  return (advances ?? []).filter((a) => a.id === keep || (a.status === "paid" && compareDecimal(a.outstanding, "0") > 0));
}

/**
 * "Settle against an advance": lists the caller's open advances (GET /expenses/my/advances/).
 * Renders nothing when there is none to settle.
 */
export function AdvanceSelect({ value, onChange, error }: { value: string; onChange: (id: string) => void; error?: string }) {
  const advances = useMyAdvances();
  const open = openAdvances(advances.data, value);
  if (open.length === 0) return null;
  return (
    <Field id="claim-advance" label="Settle against advance" error={error} hint="The approved claim first repays the advance; only the rest is paid to you.">
      <Select value={value || "none"} onValueChange={(v) => onChange(v === "none" ? "" : v)}>
        <SelectTrigger id="claim-advance" className="h-11 w-full min-w-0 *:data-[slot=select-value]:block *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No advance</SelectItem>
          {open.map((a) => <SelectItem key={a.id} value={a.id}>{a.number} · {money(a.outstanding, a.currency)} outstanding · {a.purpose}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}
