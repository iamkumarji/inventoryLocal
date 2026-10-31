"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActionError, ItemPicker, WarehouseSelect, type ItemOption } from "@/components/inventory/bits";
import { dec, isDecimal } from "@/components/inventory/decimal";
import { fieldErrors } from "@/components/inventory/problem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { ADJUSTMENT_REASONS, todayIso, useLocations } from "@/lib/api/inventory";
import { useSession } from "@/lib/session";

type Line = { key: number; item: ItemOption | null; direction: "in" | "out"; quantity: string; unit_cost: string; batch_number: string; expires_on: string; serials: string; location: string };
const NO_LOCATION = "__none__";
let nextKey = 1;
const blankLine = (direction: "in" | "out" = "in"): Line => ({ key: nextKey++, item: null, direction, quantity: "", unit_cost: "", batch_number: "", expires_on: "", serials: "", location: "" });

/** Increases are the default for opening balances and found stock; everything else removes stock. */
const DEFAULT_DIRECTION: Record<string, "in" | "out"> = { opening_balance: "in", found: "in", correction: "in", damage: "out", expiry: "out", loss: "out" };

export function NewAdjustment() {
  const { activeCompany } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ warehouse: "", posting_date: todayIso(), reason: "opening_balance", notes: "" });
  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);
  const [localError, setLocalError] = useState<string | null>(null);
  const locations = useLocations(form.warehouse || null);
  const locationList = locations.data?.results ?? [];

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const validate = (): string | null => {
    if (!form.warehouse) return "Choose the warehouse.";
    for (const [i, l] of lines.entries()) {
      const n = i + 1;
      if (!l.item) return `Line ${n}: choose an item.`;
      if (!isDecimal(l.quantity) || dec.cmp(l.quantity, "0") <= 0) return `Line ${n}: enter a quantity above zero.`;
      if (l.unit_cost && !isDecimal(l.unit_cost)) return `Line ${n}: the unit cost must be a number.`;
      if (l.item.tracking === "batch" && !l.batch_number.trim()) return `Line ${n}: ${l.item.code} is batch-tracked; enter the batch number.`;
      if (l.item.tracking === "serial" && !l.serials.trim()) return `Line ${n}: ${l.item.code} is serial-tracked; list the serial numbers.`;
    }
    return null;
  };

  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/inventory/adjustments/", {
      body: {
        company: activeCompany!.id,
        warehouse: form.warehouse,
        posting_date: form.posting_date,
        reason: form.reason as never,
        notes: form.notes,
        lines: lines.map((l) => ({
          item: l.item!.id,
          // Signed quantity: removals are negative. String prefixing, never float arithmetic.
          quantity: l.direction === "out" ? `-${dec.normalize(l.quantity)}` : dec.normalize(l.quantity),
          unit_cost: l.direction === "in" && l.unit_cost ? l.unit_cost : null,
          batch_number: l.batch_number.trim(),
          expires_on: l.direction === "in" && l.expires_on ? l.expires_on : null,
          serials: l.item!.tracking === "serial" ? l.serials.split(/[\s,]+/).filter(Boolean) : [],
          location: l.location || null,
        })),
      },
    })),
    onSuccess: (adj) => {
      queryClient.invalidateQueries({ queryKey: ["inventory", "adjustments"] });
      toast("Adjustment saved as a draft. Submit it for approval when it's complete.");
      router.push(`/inventory/adjustments/${adj.id}`);
    },
  });
  const errors = fieldErrors(create.error);

  return (
    <>
      <PageHeader crumbs={[{ label: "Adjustments", href: "/inventory/adjustments" }, { label: "New" }]} title="New stock adjustment"
        description="Saved as a draft. Nothing changes in stock until the adjustment is approved and posted." />
      <form className="grid gap-6" onSubmit={(e) => {
        e.preventDefault();
        const problem = validate();
        setLocalError(problem);
        if (!problem) create.mutate();
      }}>
        <Section title="Details">
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field id="adj-warehouse" label="Warehouse" error={errors.warehouse}>
              <WarehouseSelect id="adj-warehouse" value={form.warehouse} onChange={(v) => { setForm({ ...form, warehouse: v }); setLines((ls) => ls.map((l) => ({ ...l, location: "" }))); }} />
            </Field>
            <Field id="adj-date" label="Posting date" error={errors.posting_date}>
              <Input id="adj-date" type="date" value={form.posting_date} onChange={(e) => setForm({ ...form, posting_date: e.target.value })} required />
            </Field>
            <Field id="adj-reason" label="Reason" error={errors.reason}>
              <Select value={form.reason} onValueChange={(v) => { setForm({ ...form, reason: v }); setLines((ls) => ls.map((l) => (l.item || l.quantity ? l : { ...l, direction: DEFAULT_DIRECTION[v] ?? "in" }))); }}>
                <SelectTrigger id="adj-reason" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(ADJUSTMENT_REASONS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field id="adj-notes" label="Notes" className="sm:col-span-2 lg:col-span-1" error={errors.notes}>
              <Textarea id="adj-notes" rows={1} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="What happened" />
            </Field>
          </div>
        </Section>

        <Section title="Lines" description="Quantities are in each item's stock unit.">
          <ol className="divide-y">
            {lines.map((l, index) => {
              const prefix = `lines[${index}]`;
              const lineError = Object.entries(errors).find(([k]) => k.startsWith(prefix))?.[1];
              return (
                <li key={l.key} className="grid gap-3 px-5 py-4" aria-label={`Line ${index + 1}`}>
                  <div className="flex items-center justify-between">
                    <span className="num text-sm font-semibold text-muted-foreground">Line {index + 1}</span>
                    {lines.length > 1 && (
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${index + 1}`} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}><Trash2 /></Button>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_9rem_8rem_8rem]">
                    <Field id={`item-${l.key}`} label="Item">
                      <ItemPicker id={`item-${l.key}`} value={l.item} onChange={(item) => update(l.key, { item })} />
                    </Field>
                    <Field id={`dir-${l.key}`} label="Change">
                      <Select value={l.direction} onValueChange={(v) => update(l.key, { direction: v as "in" | "out" })}>
                        <SelectTrigger id={`dir-${l.key}`} className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="in">Add stock</SelectItem><SelectItem value="out">Remove stock</SelectItem></SelectContent>
                      </Select>
                    </Field>
                    <Field id={`qty-${l.key}`} label={`Quantity${l.item ? ` (${l.item.stock_uom_code})` : ""}`}>
                      <Input id={`qty-${l.key}`} inputMode="decimal" className="num" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                    </Field>
                    {l.direction === "in" ? (
                      <Field id={`cost-${l.key}`} label="Unit cost (₹)">
                        <Input id={`cost-${l.key}`} inputMode="decimal" className="num" value={l.unit_cost} placeholder="Average" onChange={(e) => update(l.key, { unit_cost: e.target.value })} />
                      </Field>
                    ) : <div className="hidden lg:block" />}
                  </div>
                  {(l.item?.tracking === "batch" || l.item?.tracking === "serial" || locationList.length > 0) && (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {l.item?.tracking === "batch" && (
                        <>
                          <Field id={`batch-${l.key}`} label="Batch number">
                            <Input id={`batch-${l.key}`} className="num" value={l.batch_number} onChange={(e) => update(l.key, { batch_number: e.target.value })} />
                          </Field>
                          {l.direction === "in" && (
                            <Field id={`exp-${l.key}`} label="Expires on">
                              <Input id={`exp-${l.key}`} type="date" value={l.expires_on} onChange={(e) => update(l.key, { expires_on: e.target.value })} />
                            </Field>
                          )}
                        </>
                      )}
                      {l.item?.tracking === "serial" && (
                        <Field id={`ser-${l.key}`} label="Serial numbers" hint="One per unit, separated by spaces, commas or new lines." className="sm:col-span-2">
                          <Textarea id={`ser-${l.key}`} rows={2} className="num" value={l.serials} onChange={(e) => update(l.key, { serials: e.target.value })} />
                        </Field>
                      )}
                      {locationList.length > 0 && (
                        <Field id={`loc-${l.key}`} label="Bin">
                          <Select value={l.location || NO_LOCATION} onValueChange={(v) => update(l.key, { location: v === NO_LOCATION ? "" : v })}>
                            <SelectTrigger id={`loc-${l.key}`} className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_LOCATION}>No specific bin</SelectItem>
                              {locationList.map((loc) => <SelectItem key={loc.id} value={loc.id}>{loc.code}{loc.name ? ` ${loc.name}` : ""}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </Field>
                      )}
                    </div>
                  )}
                  {lineError && <p className="text-sm text-destructive">{lineError}</p>}
                </li>
              );
            })}
          </ol>
          <div className="border-t px-5 py-3">
            <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, blankLine(DEFAULT_DIRECTION[form.reason])])}><Plus aria-hidden /> Add line</Button>
          </div>
        </Section>

        <div className="grid gap-3">
          {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
          <ActionError error={create.error} denied="You can't create adjustments for this warehouse." />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={create.isPending || !activeCompany}>{create.isPending ? "Saving…" : "Save draft"}</Button>
            <Button type="button" variant="outline" onClick={() => router.push("/inventory/adjustments")}>Cancel</Button>
          </div>
        </div>
      </form>
    </>
  );
}
