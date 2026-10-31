"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, Plus, ShoppingCart } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ActionError, CreditStatus, DocStatus, Money, Notice, today } from "@/components/trade/common";
import { add, dec, fixed, lineTaxable } from "@/components/trade/decimal";
import { FormSheet, StatusFilter, useTradeAction } from "@/components/trade/layout";
import { LineEditor } from "@/components/trade/line-editor";
import { BranchSelect, ItemPicker, PartnerPicker, StateSelect, UomSelect, WarehouseSelect } from "@/components/trade/pickers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, usePartnerIndex, type Partner } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type SO = components["schemas"]["SalesOrder"];
type SQ = components["schemas"]["SalesQuotation"];
type Line = { item: string; itemLabel: string | null; units: (string | null | undefined)[]; quantity: string; uom: string; rate: string; discount_pct: string; warehouse: string };
const blank = (): Line => ({ item: "", itemLabel: null, units: [], quantity: "", uom: "", rate: "", discount_pct: "", warehouse: "" });

function SalesDocForm({ kind, onClose }: { kind: "order" | "quotation"; onClose: () => void }) {
  const router = useRouter();
  const scopes = useCompanyScopes();
  const [customer, setCustomer] = useState<Partner | null>(null);
  const [form, setForm] = useState({ branch: "", date: today(), second: today(kind === "order" ? 7 : 30), customer_po: "", place_of_supply: "", notes: "" });
  const [lines, setLines] = useState<Line[]>([blank()]);
  const estimate = add(...lines.map((l) => lineTaxable(l.quantity, l.rate, l.discount_pct) ?? BigInt(0)));
  const ready = customer && form.branch && (kind === "quotation" || form.place_of_supply)
    && lines.every((l) => l.item && dec(l.quantity) && l.uom && dec(l.rate) && (kind === "quotation" || l.warehouse));
  const create = useTradeAction(async () => {
    const base = { company: scopes.companyId, branch: form.branch, customer: customer!.id };
    const priced = lines.map((l) => ({ item: l.item, quantity: l.quantity, uom: l.uom, rate: l.rate, discount_pct: l.discount_pct || "0" }));
    if (kind === "order") {
      return unwrap(api.POST("/api/v1/sales/orders/", {
        body: { ...base, order_date: form.date, requested_date: form.second, customer_po: form.customer_po, place_of_supply: form.place_of_supply,
          lines: priced.map((p, i) => ({ ...p, warehouse: lines[i].warehouse })) },
      }));
    }
    return unwrap(api.POST("/api/v1/sales/quotations/", { body: { ...base, quote_date: form.date, valid_until: form.second, notes: form.notes, lines: priced } }));
  }, (doc) => {
    toast(`${doc.number} saved`);
    onClose();
    router.push(kind === "order" ? `/sales/orders/${doc.id}` : `/sales/orders/quotations/${doc.id}`);
  });

  return (
    <FormSheet open onOpenChange={(o) => !o && onClose()} title={kind === "order" ? "New sales order" : "New quotation"}
      description={kind === "order" ? "Saved as a draft. Submitting runs the credit check: orders within credit are approved and stock is reserved." : "Prices and GST are fixed by the server; convert the quotation to an order when the customer accepts."}>
      <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
        <ActionError error={create.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="so-customer" label="Customer">
            <PartnerPicker id="so-customer" kind="customer" value={customer?.id ?? ""} label={customer?.name ?? null}
              onChange={(p) => { setCustomer(p); setForm((f) => ({ ...f, place_of_supply: p.state_code || f.place_of_supply })); }} />
          </Field>
          <Field id="so-branch" label="Branch"><BranchSelect id="so-branch" value={form.branch} onChange={(v) => setForm({ ...form, branch: v })} /></Field>
          <Field id="so-date" label={kind === "order" ? "Order date" : "Quote date"}><Input id="so-date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></Field>
          <Field id="so-second" label={kind === "order" ? "Requested delivery" : "Valid until"}><Input id="so-second" type="date" value={form.second} onChange={(e) => setForm({ ...form, second: e.target.value })} required /></Field>
          {kind === "order" && (
            <>
              <Field id="so-pos" label="Place of supply" hint="Defaults to the customer's state; decides CGST + SGST or IGST."><StateSelect id="so-pos" value={form.place_of_supply} onChange={(v) => setForm({ ...form, place_of_supply: v })} /></Field>
              <Field id="so-cpo" label="Customer PO"><Input id="so-cpo" maxLength={60} value={form.customer_po} onChange={(e) => setForm({ ...form, customer_po: e.target.value })} /></Field>
            </>
          )}
        </div>
        {customer?.customer_profile?.on_credit_hold && <Notice tone="rejected">{customer.name} is on credit hold. The order will be blocked at submission until someone decides on credit.</Notice>}
        <div className="grid gap-2">
          <p className="type-section">Lines</p>
          <LineEditor idPrefix="so-line" lines={lines} onChange={setLines} blank={blank} columns={[
            { key: "item", label: "Item", width: "minmax(11rem,2fr)", wide: true, render: (l, u, id) => (
              <ItemPicker id={id} purpose="sale" value={l.item} label={l.itemLabel}
                onChange={(i) => u({ item: i.id, itemLabel: `${i.code} ${i.name}`, units: [i.stock_uom, i.sales_uom], uom: i.sales_uom ?? i.stock_uom })} />) },
            { key: "qty", label: "Quantity", width: "6rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.quantity} onChange={(e) => u({ quantity: e.target.value })} /> },
            { key: "uom", label: "Unit", width: "5.5rem", render: (l, u, id) => <UomSelect id={id} value={l.uom} allowed={l.units} onChange={(v) => u({ uom: v })} /> },
            { key: "rate", label: "Rate", width: "7rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.rate} onChange={(e) => u({ rate: e.target.value })} /> },
            { key: "disc", label: "Disc %", width: "5rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.discount_pct} onChange={(e) => u({ discount_pct: e.target.value })} /> },
            ...(kind === "order" ? [{ key: "wh", label: "Ship from", width: "minmax(8rem,1.2fr)", wide: true, render: (l: Line, u: (p: Partial<Line>) => void, id: string) => (
              <WarehouseSelect id={id} branchId={form.branch || undefined} value={l.warehouse} onChange={(v) => u({ warehouse: v })} />) }] : []),
          ]} footer={<p className="text-sm text-muted-foreground">Estimate before GST: <span className="num font-medium text-foreground">₹{fixed(estimate, 2)}</span></p>} />
        </div>
        {kind === "quotation" && <Field id="sq-notes" label="Notes"><Textarea id="sq-notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>}
        <Button type="submit" disabled={!ready || create.isPending}>{kind === "order" ? "Save draft order" : "Save quotation"}</Button>
      </form>
    </FormSheet>
  );
}

export function SalesOrdersView() {
  const { can } = useSession();
  const url = useUrlState();
  const tab = url.get("tab") || "orders";
  const status = url.get("status");
  const credit = url.get("credit");
  const customers = usePartnerIndex("customer");
  const orders = useQuery({
    queryKey: tradeKey("sales-orders", status, credit, url.page),
    queryFn: () => unwrap(api.GET("/api/v1/sales/orders/", { params: { query: { status: status || undefined, credit_status: (credit || undefined) as SO["credit_status"] | undefined, page: url.page } } })),
    enabled: tab === "orders",
  });
  const quotes = useQuery({
    queryKey: tradeKey("quotations", status, url.page),
    queryFn: () => unwrap(api.GET("/api/v1/sales/quotations/", { params: { query: { status: status || undefined, page: url.page } } })),
    enabled: tab === "quotations",
  });
  const orderColumns: Column<SO>[] = [
    { key: "number", header: "Order", cell: (o) => <span><span className="num block">{o.number}</span><span className="block text-xs font-normal text-muted-foreground">{o.customer_name}</span></span> },
    { key: "date", header: "Ordered", cell: (o) => date(o.order_date) },
    { key: "amount", header: "Total", align: "right", cell: (o) => <Money value={o.amount} /> },
    { key: "status", header: "Status", cell: (o) => <DocStatus status={o.status} /> },
    { key: "credit", header: "Credit", cell: (o) => <CreditStatus status={o.credit_status} /> },
  ];
  const quoteColumns: Column<SQ>[] = [
    { key: "number", header: "Quotation", cell: (q) => <span><span className="num block">{q.number}</span><span className="block text-xs font-normal text-muted-foreground">{customers.name(q.customer)}</span></span> },
    { key: "date", header: "Quoted", cell: (q) => date(q.quote_date) },
    { key: "valid", header: "Valid until", cell: (q) => date(q.valid_until) },
    { key: "amount", header: "Total", align: "right", cell: (q) => <Money value={q.amount} /> },
    { key: "status", header: "Status", cell: (q) => <DocStatus status={q.status} /> },
  ];
  const active = tab === "orders" ? orders : quotes;
  return (
    <>
      <PageHeader title="Sales orders" description="Quotations, orders and the credit check. Approved orders reserve stock for delivery."
        actions={tab === "orders"
          ? can("sales.sales_order.create") && <Button onClick={() => url.set({ new: "order" })}><Plus aria-hidden /> New order</Button>
          : can("sales.quotation.create") && <Button onClick={() => url.set({ new: "quotation" })}><Plus aria-hidden /> New quotation</Button>} />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "orders" ? null : v, status: null, credit: null })} className="mb-4">
        <TabsList>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="quotations">Quotations</TabsTrigger>
        </TabsList>
      </Tabs>
      <Section actions={tab === "orders" ? (
        <div className="flex flex-wrap gap-3">
          <StatusFilter value={status} onChange={(v) => url.set({ status: v })}
            options={[["", "Any status"], ["draft", "Draft"], ["submitted", "Awaiting credit"], ["approved", "Approved"], ["rejected", "Rejected"]]} />
          <StatusFilter label="Filter by credit" value={credit} onChange={(v) => url.set({ credit: v })} options={[["", "Any credit"], ["blocked", "Blocked"], ["overridden", "Overridden"]]} />
        </div>
      ) : <StatusFilter value={status} onChange={(v) => url.set({ status: v })} options={[["", "Any status"], ["open", "Open"], ["accepted", "Accepted"], ["expired", "Expired"]]} />}>
        {tab === "orders" ? (
          <DataTable columns={orderColumns} rows={orders.data?.results} isLoading={orders.isLoading} error={orders.error} onRetry={orders.refetch}
            rowHref={(o) => `/sales/orders/${o.id}`} caption="Sales orders"
            empty={<EmptyState icon={ShoppingCart} title="No sales orders" description="Create an order or convert an accepted quotation." />} />
        ) : (
          <DataTable columns={quoteColumns} rows={quotes.data?.results} isLoading={quotes.isLoading} error={quotes.error} onRetry={quotes.refetch}
            rowHref={(q) => `/sales/orders/quotations/${q.id}`} caption="Quotations"
            empty={<EmptyState icon={FileText} title="No quotations" />} />
        )}
        {active.data && <PageNav page={url.page} count={active.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
      {(url.get("new") === "order" || url.get("new") === "quotation") && <SalesDocForm kind={url.get("new") as "order" | "quotation"} onClose={() => url.set({ new: null })} />}
    </>
  );
}
