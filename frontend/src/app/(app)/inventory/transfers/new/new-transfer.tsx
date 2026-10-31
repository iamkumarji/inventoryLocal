"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActionError, ItemPicker, WarehouseSelect, type ItemOption } from "@/components/inventory/bits";
import { dec, isDecimal, qty } from "@/components/inventory/decimal";
import { fieldErrors } from "@/components/inventory/problem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { useAvailability, useLocations } from "@/lib/api/inventory";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

type Line = { key: number; item: ItemOption | null; quantity: string; batch: string; serials: string; from_location: string; to_location: string };
const NONE = "__none__";
let nextKey = 1;
const blankLine = (): Line => ({ key: nextKey++, item: null, quantity: "", batch: "", serials: "", from_location: "", to_location: "" });

function AvailableHint({ item, warehouse }: { item: ItemOption | null; warehouse: string }) {
  const { can } = useSession();
  const a = useAvailability(can("inventory.stock_balance.read") ? item?.id : null, warehouse || null);
  if (!item || !warehouse || !a.data) return null;
  return <span>{qty(a.data.available, item.stock_uom_code)} free to issue</span>;
}

function BatchSelect({ id, item, value, onChange }: { id: string; item: ItemOption; value: string; onChange: (v: string) => void }) {
  const batches = useQuery({
    queryKey: ["inventory", "batches", item.id],
    queryFn: () => unwrap(api.GET("/api/v1/inventory/batches/", { params: { query: { item: item.id, page_size: 200 } } })),
  });
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full"><SelectValue placeholder={batches.isLoading ? "Loading…" : "Choose a batch"} /></SelectTrigger>
      <SelectContent>
        {batches.data?.results.map((b) => (
          <SelectItem key={b.id} value={b.id}><span className="num">{b.batch_number}</span>{b.expires_on ? <span className="text-muted-foreground"> exp. {date(b.expires_on)}</span> : null}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function NewTransfer() {
  const { activeCompany, can } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ from_warehouse: "", to_warehouse: "", notes: "" });
  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);
  const [localError, setLocalError] = useState<string | null>(null);
  const canBins = can("inventory.location.read");
  const fromBins = useLocations(form.from_warehouse || null, canBins).data?.results ?? [];
  const toBins = useLocations(form.to_warehouse || null, canBins).data?.results ?? [];
  const update = (key: number, patch: Partial<Line>) => {
    setLocalError(null); // the message described the previous input
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const validate = (): string | null => {
    if (!form.from_warehouse || !form.to_warehouse) return "Choose where the stock comes from and where it goes.";
    if (form.from_warehouse === form.to_warehouse) return "Choose a different destination warehouse.";
    for (const [i, l] of lines.entries()) {
      if (!l.item) return `Line ${i + 1}: choose an item.`;
      if (!isDecimal(l.quantity) || dec.cmp(l.quantity, "0") <= 0) return `Line ${i + 1}: enter a quantity above zero.`;
      if (l.item.tracking === "batch" && !l.batch) return `Line ${i + 1}: choose the batch to move.`;
      if (l.item.tracking === "serial" && !l.serials.trim()) return `Line ${i + 1}: list the serial numbers to move.`;
    }
    return null;
  };

  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/inventory/transfers/", {
      body: {
        company: activeCompany!.id,
        from_warehouse: form.from_warehouse,
        to_warehouse: form.to_warehouse,
        notes: form.notes,
        lines: lines.map((l) => ({
          item: l.item!.id,
          quantity: dec.normalize(l.quantity),
          batch: l.batch || null,
          serials: l.item!.tracking === "serial" ? l.serials.split(/[\s,]+/).filter(Boolean) : [],
          from_location: l.from_location || null,
          to_location: l.to_location || null,
        })),
      },
    })),
    onSuccess: (t) => {
      queryClient.invalidateQueries({ queryKey: ["inventory", "transfers"] });
      toast("Transfer saved. Dispatch it when the goods leave.");
      router.push(`/inventory/transfers/${t.id}`);
    },
  });
  const errors = fieldErrors(create.error);

  return (
    <>
      <PageHeader crumbs={[{ label: "Transfers", href: "/inventory/transfers" }, { label: "New" }]} title="New stock transfer"
        description="Saved as a draft. Stock leaves the source only when the transfer is dispatched." />
      <form className="grid gap-6" onSubmit={(e) => { e.preventDefault(); const p = validate(); setLocalError(p); if (!p) create.mutate(); }}>
        <Section title="Route">
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field id="tr-from" label="From warehouse" error={errors.from_warehouse}>
              <WarehouseSelect id="tr-from" value={form.from_warehouse} onChange={(v) => { setForm({ ...form, from_warehouse: v }); setLines((ls) => ls.map((l) => ({ ...l, from_location: "" }))); }} />
            </Field>
            <Field id="tr-to" label="To warehouse" error={errors.to_warehouse}>
              <WarehouseSelect id="tr-to" value={form.to_warehouse} exclude={form.from_warehouse} onChange={(v) => { setForm({ ...form, to_warehouse: v }); setLines((ls) => ls.map((l) => ({ ...l, to_location: "" }))); }} />
            </Field>
            <Field id="tr-notes" label="Notes" className="sm:col-span-2 lg:col-span-1">
              <Textarea id="tr-notes" rows={1} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Vehicle, reason" />
            </Field>
          </div>
        </Section>
        <Section title="Lines" description="Quantities are in each item's stock unit.">
          <ol className="divide-y">
            {lines.map((l, index) => {
              const lineError = Object.entries(errors).find(([k]) => k.startsWith(`lines[${index}]`))?.[1];
              return (
                <li key={l.key} className="grid gap-3 px-5 py-4" aria-label={`Line ${index + 1}`}>
                  <div className="flex items-center justify-between">
                    <span className="num text-sm font-semibold text-muted-foreground">Line {index + 1}</span>
                    {lines.length > 1 && <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${index + 1}`} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}><Trash2 /></Button>}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                    <Field id={`item-${l.key}`} label="Item">
                      <ItemPicker id={`item-${l.key}`} value={l.item} onChange={(item) => update(l.key, { item, batch: "", serials: "" })} />
                    </Field>
                    <Field id={`qty-${l.key}`} label={`Quantity${l.item ? ` (${l.item.stock_uom_code})` : ""}`} hint={<AvailableHint item={l.item} warehouse={form.from_warehouse} />}>
                      <Input id={`qty-${l.key}`} inputMode="decimal" className="num" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                    </Field>
                  </div>
                  {(l.item?.tracking === "batch" || l.item?.tracking === "serial" || fromBins.length > 0 || toBins.length > 0) && (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {l.item?.tracking === "batch" && can("inventory.batch.read") && (
                        <Field id={`batch-${l.key}`} label="Batch"><BatchSelect id={`batch-${l.key}`} item={l.item} value={l.batch} onChange={(v) => update(l.key, { batch: v })} /></Field>
                      )}
                      {l.item?.tracking === "serial" && (
                        <Field id={`ser-${l.key}`} label="Serial numbers" hint="One per unit." className="sm:col-span-2">
                          <Textarea id={`ser-${l.key}`} rows={2} className="num" value={l.serials} onChange={(e) => update(l.key, { serials: e.target.value })} />
                        </Field>
                      )}
                      {fromBins.length > 0 && (
                        <Field id={`fb-${l.key}`} label="From bin">
                          <Select value={l.from_location || NONE} onValueChange={(v) => update(l.key, { from_location: v === NONE ? "" : v })}>
                            <SelectTrigger id={`fb-${l.key}`} className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value={NONE}>Any bin</SelectItem>{fromBins.map((b) => <SelectItem key={b.id} value={b.id}>{b.code}</SelectItem>)}</SelectContent>
                          </Select>
                        </Field>
                      )}
                      {toBins.length > 0 && (
                        <Field id={`tb-${l.key}`} label="To bin">
                          <Select value={l.to_location || NONE} onValueChange={(v) => update(l.key, { to_location: v === NONE ? "" : v })}>
                            <SelectTrigger id={`tb-${l.key}`} className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value={NONE}>No specific bin</SelectItem>{toBins.map((b) => <SelectItem key={b.id} value={b.id}>{b.code}</SelectItem>)}</SelectContent>
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
            <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, blankLine()])}><Plus aria-hidden /> Add line</Button>
          </div>
        </Section>
        <div className="grid gap-3">
          {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
          <ActionError error={create.error} denied="You can't create transfers from this warehouse." />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={create.isPending || !activeCompany}>{create.isPending ? "Saving…" : "Save transfer"}</Button>
            <Button type="button" variant="outline" onClick={() => router.push("/inventory/transfers")}>Cancel</Button>
          </div>
        </div>
      </form>
    </>
  );
}
