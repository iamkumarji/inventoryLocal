"use client";

import { subMonths } from "date-fns";
import type { ReactNode } from "react";

import { StatusBadge, type Tone } from "@/components/erp/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STATUS_LABEL, fiscalYearStart, isoDate, monthStart, today } from "@/lib/api/finance";
import { cn } from "@/lib/utils";

const DOC_TONES: Record<string, Tone> = {
  draft: "neutral",
  submitted: "pending",
  approved: "info",
  rejected: "rejected",
  posted: "approved",
  cancelled: "neutral",
};

export function DocStatus({ status }: { status: string }) {
  return <StatusBadge tone={DOC_TONES[status] ?? "neutral"}>{STATUS_LABEL[status] ?? status}</StatusBadge>;
}

const MATCH: Record<string, { tone: Tone; label: string }> = {
  pending: { tone: "neutral", label: "Not matched yet" },
  matched: { tone: "approved", label: "Three-way matched" },
  variance: { tone: "pending", label: "Price variance" },
};
export function MatchStatus({ status }: { status: string }) {
  const m = MATCH[status] ?? { tone: "neutral" as Tone, label: status };
  return <StatusBadge tone={m.tone}>{m.label}</StatusBadge>;
}

export function defaultRange() {
  return { from: fiscalYearStart(), to: today() };
}

function presets() {
  const now = new Date();
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  return [
    { label: "This month", from: monthStart(now), to: today() },
    { label: "Last month", from: monthStart(subMonths(now, 1)), to: isoDate(lastMonthEnd) },
    { label: "This fiscal year", from: fiscalYearStart(now), to: today() },
  ];
}

/** Date range with quick presets. Values are ISO dates; the caller stores them (usually in the URL). */
export function DateRange({ from, to, onChange, idPrefix = "range" }: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  idPrefix?: string;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-from`} className="text-xs text-muted-foreground">From</Label>
        <Input id={`${idPrefix}-from`} type="date" value={from} max={to || undefined} className="h-9 w-[9.5rem]"
          onChange={(e) => e.target.value && onChange({ from: e.target.value, to })} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-to`} className="text-xs text-muted-foreground">To</Label>
        <Input id={`${idPrefix}-to`} type="date" value={to} min={from || undefined} className="h-9 w-[9.5rem]"
          onChange={(e) => e.target.value && onChange({ from, to: e.target.value })} />
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Quick ranges">
        {presets().map((p) => (
          <Button key={p.label} type="button" size="sm" variant={p.from === from && p.to === to ? "secondary" : "ghost"}
            aria-pressed={p.from === from && p.to === to} onClick={() => onChange({ from: p.from, to: p.to })}>
            {p.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function AsOf({ value, onChange, id = "as-of", label = "As of" }: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  label?: string;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Input id={id} type="date" value={value} className="h-9 w-[9.5rem]" onChange={(e) => e.target.value && onChange(e.target.value)} />
    </div>
  );
}

/** A bar of filters above content, wrapping on narrow screens. */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-4 flex flex-wrap items-end gap-x-4 gap-y-3", className)}>{children}</div>;
}

/** Key figures shown as a definition grid (e.g. totals at the top of a document). */
export function Figures({ items, className }: { items: { label: string; value: ReactNode; hint?: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4", className)}>
      {items.map((item) => (
        <div key={item.label} className="bg-card px-4 py-3">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 text-base font-semibold">{item.value}</dd>
          {item.hint && <dd className="mt-0.5 text-xs text-muted-foreground">{item.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** Notice for a capability the screen can't offer yet (kept visible rather than silently missing). */
export function Unavailable({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed bg-card px-5 py-4">
      <p className="font-medium">{title}</p>
      <div className="mt-1 max-w-[70ch] text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
