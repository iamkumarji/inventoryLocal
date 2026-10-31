"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, ShoppingCart } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ActionError, DocStatus, Money, Notice, today } from "@/components/trade/common";
import { add, dec, fixed, lineTaxable } from "@/components/trade/decimal";
import { FormSheet, StatusFilter, useTradeAction } from "@/components/trade/layout";
import { LineEditor } from "@/components/trade/line-editor";
import { BranchSelect, ItemPicker, PartnerPicker, UomSelect, WarehouseSelect } from "@/components/trade/pickers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, type Partner } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type PO = components["schemas"]["PurchaseOrder"];
type Line = {
  item: string; itemLabel: string | null; units: (string | null | undefined)[]; quantity: string; uom: string; rate: string;
  discount_pct: string; warehouse: string; over_receipt_pct: string;
};
const blank = (): Line => ({ item: "", itemLabel: null, units: [], quantity: "", uom: "", rate: "", discount_pct: "", warehouse: "", over_receipt_pct: "" });

function NewOrder({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const { me, activeCompany } = useSession();
  const [supplier, setSupplier] = useState<Partner | null>(null);
  const [form, setForm] = useState({ branch: "", order_date: today(), expected_date: today(14), payment_terms_days: "", notes: "" });
  const [lines, setLines] = useState<Line[]>([blank()]);
  const estimate = add(...lines.map((l) => lineTaxable(l.quantity, l.rate, l.discount_pct) ?? BigInt(0)));
  const ready = supplier && form.branch && lines.every((l) => l.item && dec(l.quantity) && l.uom && dec(l.rate) && l.warehouse);
  const create = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/orders/", {
      body: {
        company: activeCompany?.id ?? me.active_company_id ?? "", branch: form.branch, supplier: supplier!.id,
        order_date: form.order_date, expected_date: form.expected_date, notes: form.notes,
        ...(form.payment_terms_days ? { payment_terms_days: Number(form.payment_terms_days) } : {}),
        lines: lines.map((l) => ({
          item: l.item, quantity: l.quantity, uom: l.uom, rate: l.rate, discount_pct: l.discount_pct || "0", warehouse: l.warehouse,
          over_receipt_pct: l.over_receipt_pct || "0",
        })),
      },
    })),
  (po) => { toast(`${po.number} saved as draft`); onOpenChange(false); router.push(`/procurement/orders/${po.id}`); });

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title="New purchase order" description="GST is worked out by the server from each item's HSN code and the supplier's state.">
      <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
        <ActionError error={create.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="po-supplier" label="Supplier">
            <PartnerPicker id="po-supplier" kind="supplier" value={supplier?.id ?? ""} label={supplier?.name ?? null}
              onChange={(p) => { setSupplier(p); setForm((f) => ({ ...f, payment_terms_days: f.payment_terms_days || String(p.supplier_profile?.payment_terms_days ?? "") })); }} />
          </Field>
          <Field id="po-branch" label="Branch"><BranchSelect id="po-branch" value={form.branch} onChange={(v) => setForm({ ...form, branch: v })} /></Field>
          <Field id="po-date" label="Order date"><Input id="po-date" type="date" value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} required /></Field>
          <Field id="po-expected" label="Expected by"><Input id="po-expected" type="date" value={form.expected_date} onChange={(e) => setForm({ ...form, expected_date: e.target.value })} required /></Field>
          <Field id="po-terms" label="Payment terms (days)"><Input id="po-terms" inputMode="numeric" className="num" value={form.payment_terms_days} onChange={(e) => setForm({ ...form, payment_terms_days: e.target.value.replace(/\D/g, "") })} /></Field>
        </div>
        {supplier && !supplier.supplier_profile?.is_approved_vendor && <Notice tone="pending">{supplier.name} isn&apos;t an approved vendor yet; the server will refuse the order until someone approves it.</Notice>}
        <div className="grid gap-2">
          <p className="type-section">Lines</p>
          <LineEditor idPrefix="po-line" lines={lines} onChange={setLines} blank={blank} columns={[
            { key: "item", label: "Item", width: "minmax(11rem,2fr)", wide: true, render: (l, u, id) => (
              <ItemPicker id={id} purpose="purchase" value={l.item} label={l.itemLabel}
                onChange={(i) => u({ item: i.id, itemLabel: `${i.code} ${i.name}`, units: [i.stock_uom, i.purchase_uom], uom: i.purchase_uom ?? i.stock_uom })} />) },
            { key: "qty", label: "Quantity", width: "5.5rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.quantity} onChange={(e) => u({ quantity: e.target.value })} /> },
            { key: "uom", label: "Unit", width: "5.5rem", render: (l, u, id) => <UomSelect id={id} value={l.uom} allowed={l.units} onChange={(v) => u({ uom: v })} /> },
            { key: "rate", label: "Rate", width: "6.5rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.rate} onChange={(e) => u({ rate: e.target.value })} /> },
            { key: "disc", label: "Disc %", width: "4.5rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.discount_pct} onChange={(e) => u({ discount_pct: e.target.value })} /> },
            { key: "tol", label: "Over-receipt %", width: "5.5rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.over_receipt_pct} placeholder="0" onChange={(e) => u({ over_receipt_pct: e.target.value })} /> },
            { key: "wh", label: "Deliver to", width: "minmax(8rem,1.2fr)", wide: true, render: (l, u, id) => <WarehouseSelect id={id} branchId={form.branch || undefined} value={l.warehouse} onChange={(v) => u({ warehouse: v })} /> },
          ]} footer={<p className="text-sm text-muted-foreground">Estimate before GST: <span className="num font-medium text-foreground">₹{fixed(estimate, 2)}</span></p>} />
        </div>
        <Field id="po-notes" label="Notes"><Textarea id="po-notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <Button type="submit" disabled={!ready || create.isPending}>Save draft</Button>
      </form>
    </FormSheet>
  );
}

export const PO_STATUSES: [string, string][] = [["", "Any status"], ["draft", "Draft"], ["submitted", "Submitted"], ["approved", "Approved"], ["rejected", "Rejected"], ["cancelled", "Cancelled"]];

export function OrdersView() {
  const { can } = useSession();
  const url = useUrlState();
  const status = url.get("status");
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: tradeKey("orders", status, url.page),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/orders/", { params: { query: { status: status || undefined, page: url.page } } })),
  });
  const columns: Column<PO>[] = [
    { key: "number", header: "Order", cell: (o) => <span><span className="num block">{o.number}</span><span className="block text-xs font-normal text-muted-foreground">{o.supplier_name}</span></span> },
    { key: "date", header: "Ordered", cell: (o) => date(o.order_date) },
    { key: "expected", header: "Expected", cell: (o) => date(o.expected_date) },
    { key: "amount", header: "Total", align: "right", cell: (o) => <Money value={o.amount} /> },
    { key: "status", header: "Status", cell: (o) => <DocStatus status={o.status} /> },
    { key: "receipt", header: "Receipt", cell: (o) => (o.status === "approved" ? <DocStatus status={o.receipt_status} /> : <span className="text-muted-foreground">—</span>) },
  ];
  return (
    <>
      <PageHeader title="Purchase orders" description="Orders to suppliers with CGST/SGST or IGST worked out per line. Approved orders can be received."
        actions={can("procurement.purchase_order.create") && <Button onClick={() => setOpen(true)}><Plus aria-hidden /> New order</Button>} />
      <Section actions={<StatusFilter value={status} options={PO_STATUSES} onChange={(v) => url.set({ status: v })} />}>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(o) => `/procurement/orders/${o.id}`} caption="Purchase orders"
          empty={<EmptyState icon={ShoppingCart} title="No purchase orders" description="Create one directly or select a quotation on an RFQ." />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
      <NewOrder open={open} onOpenChange={setOpen} />
    </>
  );
}
