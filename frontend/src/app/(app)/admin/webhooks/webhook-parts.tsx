"use client";

import { Plus, X } from "lucide-react";
import { useId, useState } from "react";

import { StatusBadge, type Tone } from "@/components/erp/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { components } from "@/lib/api/schema";

export type Endpoint = components["schemas"]["WebhookEndpoint"];
export type Delivery = components["schemas"]["WebhookDelivery"];

/** Events the platform publishes today, offered as suggestions; any exact type or `module.*` prefix is accepted. */
const SUGGESTIONS = [
  "sales.*", "procurement.*", "finance.*", "inventory.*", "manufacturing.*", "assets.*", "logistics.*", "quality.*", "approvals.*",
  "sales.invoice.posted", "sales.order.approved", "sales.delivery.posted", "procurement.goods_receipt.posted",
  "procurement.purchase_return.posted", "finance.payment.posted", "inventory.stock.posted", "manufacturing.order.released",
  "manufacturing.output.received", "assets.asset.capitalized", "assets.asset.disposed", "assets.depreciation.posted",
  "assets.work_order.completed", "logistics.shipment.dispatched", "quality.inspection.created", "quality.inspection.decided",
  "approvals.request.submitted", "approvals.request.withdrawn", "approvals.step.escalated",
];

/** Mirrors the server's rule so mistakes show before submitting; the server still decides. */
export function eventTypeProblem(pattern: string): string | null {
  const p = pattern.trim();
  if (!p) return "Enter an event type.";
  if (p === "*" || p === ".*") return "Subscribing to everything isn't allowed: choose events or modules such as procurement.*.";
  if ((p.match(/\*/g) ?? []).length > 1) return `'${p}': use at most one wildcard.`;
  if (p.includes("*") && !p.endsWith(".*")) return `'${p}': a wildcard may only end a module prefix, e.g. procurement.*.`;
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*(\.\*)?$/.test(p)) return `'${p}': use lower-case names separated by dots, e.g. sales.invoice.posted.`;
  return null;
}

export function eventTypesOf(endpoint: Endpoint): string[] {
  return Array.isArray(endpoint.event_types) ? (endpoint.event_types as unknown[]).filter((x): x is string => typeof x === "string") : [];
}

export function EventTypesInput({ id, value, onChange, invalid }: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  invalid?: boolean;
}) {
  const listId = useId();
  const [draft, setDraft] = useState("");
  const problem = draft.trim() ? eventTypeProblem(draft) : null;
  const add = () => {
    const p = draft.trim();
    if (!p || eventTypeProblem(p)) return;
    if (!value.includes(p)) onChange([...value, p].sort());
    setDraft("");
  };
  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Input id={id} list={listId} value={draft} placeholder="e.g. sales.invoice.posted or procurement.*" autoComplete="off"
          aria-invalid={invalid || Boolean(problem)} className="num min-w-0"
          onChange={(e) => setDraft(e.target.value.toLowerCase())}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <datalist id={listId}>
          {SUGGESTIONS.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}
        </datalist>
        <Button type="button" variant="outline" onClick={add} disabled={!draft.trim() || Boolean(problem)}>
          <Plus aria-hidden /> Add
        </Button>
      </div>
      {problem && <p className="text-sm text-destructive">{problem}</p>}
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Subscribed events">
          {value.map((t) => (
            <li key={t} className="num inline-flex h-7 max-w-full items-center gap-1 rounded-sm border bg-muted pr-1 pl-2 text-xs">
              <span className="truncate">{t}</span>
              <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`}
                className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground">
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Add exact event types, or a module prefix ending in .* to receive all of a module&apos;s events.</p>
      )}
    </div>
  );
}

export function EventTypeList({ types, max = 3 }: { types: string[]; max?: number }) {
  if (types.length === 0) return <span className="text-muted-foreground">None</span>;
  const shown = types.slice(0, max);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((t) => <span key={t} className="num rounded-sm border bg-muted px-1.5 py-0.5 text-xs">{t}</span>)}
      {types.length > max && <span className="text-xs text-muted-foreground">+{types.length - max} more</span>}
    </span>
  );
}

const DELIVERY: Record<Delivery["status"], { tone: Tone; label: string }> = {
  pending: { tone: "pending", label: "Queued" },
  succeeded: { tone: "approved", label: "Delivered" },
  failed: { tone: "rejected", label: "Failed, retrying" },
  dead: { tone: "rejected", label: "Gave up" },
};

export function DeliveryStatus({ status }: { status: Delivery["status"] }) {
  const d = DELIVERY[status] ?? { tone: "neutral" as Tone, label: status };
  return <StatusBadge tone={d.tone}>{d.label}</StatusBadge>;
}
