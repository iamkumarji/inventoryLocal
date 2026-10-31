"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { ActionError } from "@/components/finance/action-error";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { PartnerPicker, type PartnerOption } from "@/components/finance/pickers";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { formatDecimal, fromUnits, isPositiveAmount, today, toUnits } from "@/lib/api/finance";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

type Draft = { include: boolean; quantity: string; rate: string };
const NUM = /^\d*(\.\d{0,6})?$/;

export function NewSupplierInvoice() {
  const { activeCompany } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [supplier, setSupplier] = useState<PartnerOption | null>(null);
  const [receiptId, setReceiptId] = useState("");
  const [number, setNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const receipts = useQuery({
    queryKey: ["procurement", "receipts", "for-invoice", supplier?.id],
    queryFn: () => unwrap(api.GET("/api/v1/procurement/receipts/", { params: { query: { supplier: supplier!.id, status: "posted", page_size: 100 } } })),
    enabled: !!supplier,
  });
  const receipt = receipts.data?.results.find((r) => r.id === receiptId);
  const order = useQuery({
    queryKey: ["procurement", "order", receipt?.purchase_order],
    queryFn: () => unwrap(api.GET("/api/v1/procurement/orders/{id}/", { params: { path: { id: receipt!.purchase_order } } })),
    enabled: !!receipt,
  });
  const poLine = (id: string) => order.data?.lines.find((l) => l.id === id);
  const openQty = (q: string, invoiced: string) => fromUnits(toUnits(q) - toUnits(invoiced), 4);

  const chooseReceipt = (id: string) => {
    setReceiptId(id);
    const r = receipts.data?.results.find((x) => x.id === id);
    const next: Record<string, Draft> = {};
    for (const line of r?.lines ?? []) {
      const open = openQty(line.quantity, line.invoiced_quantity);
      next[line.id] = { include: toUnits(open) > BigInt(0), quantity: toUnits(open) > BigInt(0) ? open.replace(/\.?0+$/, "") : "", rate: "" };
    }
    setDrafts(next);
  };
  const draftFor = (lineId: string, poLineId: string): Draft => {
    const d = drafts[lineId] ?? { include: false, quantity: "", rate: "" };
    return { ...d, rate: d.rate || (poLine(poLineId)?.rate ?? "") };
  };
  const selected = (receipt?.lines ?? []).filter((l) => draftFor(l.id, l.po_line).include);
  const valid = selected.length > 0 && selected.every((l) => {
    const d = draftFor(l.id, l.po_line);
    return isPositiveAmount(d.quantity) && /^\d+(\.\d{1,6})?$/.test(d.rate);
  }) && number.trim() && supplier && receipt;

  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/finance/supplier-invoices/", {
      body: {
        company: activeCompany!.id,
        supplier: supplier!.id,
        supplier_invoice_number: number.trim(),
        invoice_date: invoiceDate,
        purchase_order: receipt!.purchase_order,
        lines: selected.map((l) => {
          const d = draftFor(l.id, l.po_line);
          return { grn_line: l.id, quantity: d.quantity, rate: d.rate };
        }),
      },
    })),
    onSuccess: (inv) => {
      queryClient.invalidateQueries({ queryKey: ["finance", "supplier-invoices"] });
      router.push(`/finance/payables/${inv.id}`);
    },
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate(); }}>
      <PageHeader crumbs={[{ label: "Payables", href: "/finance/payables" }, { label: "Record invoice" }]} title="Record a supplier invoice"
        description="Enter what the supplier billed against a posted goods receipt. Quantities and rates are checked against the receipt and the order when you submit." />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
        <Section title="Invoice">
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field id="supplier" label="Supplier"><PartnerPicker id="supplier" kind="supplier" value={supplier} onChange={(p) => { setSupplier(p); setReceiptId(""); setDrafts({}); }} /></Field>
            <Field id="receipt" label="Goods receipt">
              <Select value={receiptId} onValueChange={chooseReceipt} disabled={!supplier}>
                <SelectTrigger id="receipt" className="w-full"><SelectValue placeholder={supplier ? "Choose a receipt" : "Choose a supplier first"} /></SelectTrigger>
                <SelectContent>
                  {(receipts.data?.results ?? []).map((r) => <SelectItem key={r.id} value={r.id}>{r.number} · {date(r.receipt_date)}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field id="supplier_invoice_number" label="Supplier's invoice number">
              <Input id="supplier_invoice_number" value={number} onChange={(e) => setNumber(e.target.value)} maxLength={60} required />
            </Field>
            <Field id="invoice_date" label="Invoice date"><Input id="invoice_date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} required /></Field>
          </div>
        </Section>
        <Section title="Lines billed" description="Untick lines the supplier hasn't billed yet. Rates default to the order rate.">
          {!supplier || !receiptId ? (
            receipts.error ? <ErrorState error={receipts.error} /> :
              supplier && receipts.data?.results.length === 0 ? <EmptyState icon={PackageCheck} title="No posted receipts for this supplier" /> :
                <EmptyState icon={PackageCheck} title="Choose a supplier and a goods receipt" />
          ) : order.isLoading ? <RowsSkeleton rows={3} /> : (
            <LedgerTable caption="Receipt lines" columns={[
              { key: "inc", header: <span className="sr-only">Include</span> }, { key: "item", header: "Item" },
              { key: "received", header: "Received", align: "right" }, { key: "open", header: "Open to bill", align: "right" },
              { key: "order_rate", header: "Order rate", align: "right" }, { key: "qty", header: "Billed qty", align: "right" },
              { key: "rate", header: "Billed rate", align: "right" },
            ]}>
              {receipt!.lines.map((l) => {
                const d = draftFor(l.id, l.po_line);
                const set = (patch: Partial<Draft>) => setDrafts((all) => ({ ...all, [l.id]: { ...d, ...patch } }));
                return (
                  <Row key={l.id}>
                    <Cell><Checkbox checked={d.include} onCheckedChange={(v) => set({ include: v === true })} aria-label={`Bill ${l.item_code}`} /></Cell>
                    <Cell className="font-sans">{l.item_code}<span className="block text-xs text-muted-foreground">{poLine(l.po_line)?.item_name}</span></Cell>
                    <Cell align="right">{formatDecimal(l.quantity, { dp: 3 })}</Cell>
                    <Cell align="right">{formatDecimal(openQty(l.quantity, l.invoiced_quantity), { dp: 3 })}</Cell>
                    <Cell align="right">{formatDecimal(poLine(l.po_line)?.rate, { dp: 2 })}</Cell>
                    <Cell align="right"><Input className="num ml-auto h-8 w-24 text-right" inputMode="decimal" aria-label={`Billed quantity ${l.item_code}`}
                      value={d.quantity} disabled={!d.include} onChange={(e) => NUM.test(e.target.value) && set({ quantity: e.target.value })} /></Cell>
                    <Cell align="right"><Input className="num ml-auto h-8 w-28 text-right" inputMode="decimal" aria-label={`Billed rate ${l.item_code}`}
                      value={d.rate} disabled={!d.include} onChange={(e) => NUM.test(e.target.value) && set({ rate: e.target.value })} /></Cell>
                  </Row>
                );
              })}
            </LedgerTable>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3 border-t px-5 py-3">
            <span className="text-xs text-muted-foreground">Tax and totals are calculated by the server from the order&apos;s GST rates.</span>
            <Button type="submit" disabled={!valid || create.isPending}>{create.isPending ? "Saving…" : "Save draft"}</Button>
          </div>
        </Section>
        <ActionError error={create.error} />
      </div>
    </form>
  );
}
