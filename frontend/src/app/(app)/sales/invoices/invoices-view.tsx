"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, ReceiptIndianRupee, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ActionError, DocStatus, Money, Notice, today } from "@/components/trade/common";
import { dec, dec0, toPlain, trim } from "@/components/trade/decimal";
import { FormSheet, StatusFilter, useTradeAction } from "@/components/trade/layout";
import { LineEditor } from "@/components/trade/line-editor";
import { WarehouseSelect } from "@/components/trade/pickers";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useItemIndex, usePartnerIndex } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type SI = components["schemas"]["SalesInvoice"];
type CN = components["schemas"]["SalesReturn"];
type RetLine = { invoice_line: string; quantity: string; restock: boolean };

function NewInvoice({ initialSo, onClose }: { initialSo: string; onClose: () => void }) {
  const router = useRouter();
  const items = useItemIndex();
  const [soId, setSoId] = useState(initialSo);
  const [invoiceDate, setInvoiceDate] = useState(today());
  const orders = useQuery({
    queryKey: tradeKey("sales-orders", "approved"),
    queryFn: () => unwrap(api.GET("/api/v1/sales/orders/", { params: { query: { status: "approved", page_size: 100 } } })),
  });
  const pending = (orders.data?.results ?? []).filter((o) => o.lines.some((l) => dec0(l.delivered_quantity) > dec0(l.invoiced_quantity)));
  const so = orders.data?.results.find((o) => o.id === soId);
  const preview = (so?.lines ?? []).filter((l) => dec0(l.delivered_quantity) > dec0(l.invoiced_quantity));
  const create = useTradeAction(() => unwrap(api.POST("/api/v1/sales/invoices/", { body: { sales_order: soId, invoice_date: invoiceDate } })),
    (inv) => { toast("Draft invoice created. Post it to assign the invoice number."); onClose(); router.push(`/sales/invoices/${inv.id}`); });
  return (
    <FormSheet open onOpenChange={(o) => !o && onClose()} wide={false} title="New sales invoice" description="Invoices everything delivered and not yet invoiced on the order. GST and totals are worked out by the server.">
      <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
        <ActionError error={create.error} />
        <Field id="si-so" label="Sales order">
          <Select value={soId} onValueChange={setSoId}>
            <SelectTrigger id="si-so" className="w-full"><SelectValue placeholder="Order with delivered, uninvoiced goods" /></SelectTrigger>
            <SelectContent>{[...pending, ...(so && !pending.includes(so) ? [so] : [])].map((o) => <SelectItem key={o.id} value={o.id}>{o.number} · {o.customer_name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field id="si-date" label="Invoice date"><Input id="si-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} required /></Field>
        {so && (preview.length === 0 ? <Notice tone="pending">Nothing delivered on this order is waiting to be invoiced.</Notice> : (
          <div className="grid gap-1 rounded-md border px-3 py-2 text-sm">
            <p className="text-xs font-medium text-muted-foreground uppercase">Will be invoiced</p>
            {preview.map((l) => (
              <p key={l.id} className="num flex justify-between gap-4">
                <span>{l.item_code}</span>
                <span>{toPlain(dec0(l.delivered_quantity) - dec0(l.invoiced_quantity))} {items.get(l.item)?.stock_uom_code}</span>
              </p>
            ))}
          </div>
        ))}
        <Button type="submit" disabled={!soId || preview.length === 0 || create.isPending}>Create draft invoice</Button>
      </form>
    </FormSheet>
  );
}

function NewReturn({ initialInvoice, onClose }: { initialInvoice: string; onClose: () => void }) {
  const router = useRouter();
  const items = useItemIndex();
  const [invId, setInvId] = useState(initialInvoice);
  const [form, setForm] = useState({ warehouse: "", return_date: today(), reason: "" });
  const [lines, setLines] = useState<RetLine[]>([]);
  const posted = useQuery({
    queryKey: tradeKey("invoices", "posted"),
    queryFn: () => unwrap(api.GET("/api/v1/sales/invoices/", { params: { query: { status: "posted", page_size: 100 } } })),
  });
  const inv = posted.data?.results.find((i) => i.id === invId);
  const [seeded, setSeeded] = useState("");
  if (inv && seeded !== inv.id) {
    setSeeded(inv.id);
    setLines(inv.lines.map((l) => ({ invoice_line: l.id, quantity: "", restock: true })));
  }
  const chosen = lines.filter((l) => dec(l.quantity) && dec0(l.quantity) > BigInt(0));
  const create = useTradeAction(() =>
    unwrap(api.POST("/api/v1/sales/returns/", { body: { invoice: invId, ...form, lines: chosen } })),
  (r) => { toast("Return saved as draft. Post it to issue the credit note."); onClose(); router.push(`/sales/invoices/returns/${r.id}`); });
  return (
    <FormSheet open onOpenChange={(o) => !o && onClose()} title="New sales return" description="Posting issues a credit note with the GST reversed in proportion. Restocked goods go back to unrestricted stock; others to blocked stock.">
      <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
        <ActionError error={create.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="sr-inv" label="Invoice" className="sm:col-span-2">
            <Select value={invId} onValueChange={setInvId}>
              <SelectTrigger id="sr-inv" className="w-full"><SelectValue placeholder="Choose a posted invoice" /></SelectTrigger>
              <SelectContent>{posted.data?.results.map((i) => <SelectItem key={i.id} value={i.id}>{i.number} · {i.customer_name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="sr-wh" label="Return to warehouse"><WarehouseSelect id="sr-wh" branchId={inv?.branch} value={form.warehouse} onChange={(v) => setForm({ ...form, warehouse: v })} /></Field>
          <Field id="sr-date" label="Return date"><Input id="sr-date" type="date" value={form.return_date} onChange={(e) => setForm({ ...form, return_date: e.target.value })} /></Field>
          <Field id="sr-reason" label="Reason" className="sm:col-span-2"><Input id="sr-reason" maxLength={300} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required /></Field>
        </div>
        {inv && (
          <LineEditor idPrefix="sr-line" lines={lines} onChange={setLines} readOnlyCount columns={[
            { key: "item", label: "Item", width: "minmax(10rem,2fr)", wide: true, render: (_l, _u, _id, i) => (
              <p className="num py-2 text-sm">{items.get(inv.lines[i].item)?.code ?? `HSN ${inv.lines[i].hsn_code || "—"}`} <span className="text-muted-foreground">invoiced {trim(inv.lines[i].quantity)}, returned {trim(inv.lines[i].returned_quantity)}</span></p>) },
            { key: "qty", label: "Return", width: "7rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.quantity} onChange={(e) => u({ quantity: e.target.value })} /> },
            { key: "restock", label: "Restock", width: "6rem", render: (l, u, id) => (
              <label className="flex h-9 items-center gap-2 text-sm"><Checkbox id={id} checked={l.restock} onCheckedChange={(v) => u({ restock: v === true })} /> Saleable</label>) },
          ]} />
        )}
        <Button type="submit" disabled={!invId || !form.warehouse || !form.reason.trim() || chosen.length === 0 || create.isPending}>Save draft return</Button>
      </form>
    </FormSheet>
  );
}

export function InvoicesView() {
  const { can } = useSession();
  const url = useUrlState();
  const tab = url.get("tab") || "invoices";
  const status = url.get("status");
  const customers = usePartnerIndex("customer");
  const invoices = useQuery({
    queryKey: tradeKey("invoices", status, url.page),
    queryFn: () => unwrap(api.GET("/api/v1/sales/invoices/", { params: { query: { status: status || undefined, page: url.page } } })),
    enabled: tab === "invoices",
  });
  const returns = useQuery({
    queryKey: tradeKey("sales-returns", status, url.page),
    queryFn: () => unwrap(api.GET("/api/v1/sales/returns/", { params: { query: { status: status || undefined, page: url.page } } })),
    enabled: tab === "returns",
  });
  const postedInvoices = useQuery({
    queryKey: tradeKey("invoices", "posted"),
    queryFn: () => unwrap(api.GET("/api/v1/sales/invoices/", { params: { query: { status: "posted", page_size: 100 } } })),
    enabled: tab === "returns",
  });
  const invNumber = useMemo(() => new Map((postedInvoices.data?.results ?? []).map((i) => [i.id, i.number])), [postedInvoices.data]);
  const invColumns: Column<SI>[] = [
    { key: "number", header: "Invoice", cell: (i) => <span><span className="num block">{i.number || "Draft"}</span><span className="block text-xs font-normal text-muted-foreground">{i.customer_name}</span></span> },
    { key: "date", header: "Date", cell: (i) => date(i.invoice_date) },
    { key: "due", header: "Due", cell: (i) => date(i.due_date) },
    { key: "gst", header: "GST", cell: (i) => <span className="text-muted-foreground">{i.intra_state ? "CGST + SGST" : "IGST"}</span> },
    { key: "total", header: "Total", align: "right", cell: (i) => <Money value={i.total} /> },
    { key: "status", header: "Status", cell: (i) => <DocStatus status={i.status} /> },
  ];
  const retColumns: Column<CN>[] = [
    { key: "number", header: "Credit note", cell: (r) => <span><span className="num block">{r.number || "Draft"}</span><span className="block text-xs font-normal text-muted-foreground">{customers.name(r.customer)}</span></span> },
    { key: "inv", header: "Invoice", cell: (r) => <span className="num">{invNumber.get(r.invoice) ?? "—"}</span> },
    { key: "date", header: "Date", cell: (r) => date(r.return_date) },
    { key: "reason", header: "Reason", cell: (r) => <span className="block max-w-[28ch] truncate">{r.reason}</span> },
    { key: "credit", header: "Credit", align: "right", cell: (r) => (r.status === "posted" ? <Money value={r.credit_total} /> : <span className="text-muted-foreground">On posting</span>) },
    { key: "status", header: "Status", cell: (r) => <DocStatus status={r.status} /> },
  ];
  const active = tab === "invoices" ? invoices : returns;
  return (
    <>
      <PageHeader title="Sales invoices" description="GST invoices from delivered quantities. Invoice numbers come from a gapless series when the invoice is posted."
        actions={tab === "invoices"
          ? can("sales.invoice.create") && <Button onClick={() => url.set({ new: 1 })}><Plus aria-hidden /> New invoice</Button>
          : can("sales.sales_return.create") && <Button onClick={() => url.set({ newReturn: 1 })}><Undo2 aria-hidden /> New return</Button>} />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "invoices" ? null : v, status: null })} className="mb-4">
        <TabsList>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="returns">Returns and credit notes</TabsTrigger>
        </TabsList>
      </Tabs>
      <Section actions={<StatusFilter value={status} options={[["", "Any status"], ["draft", "Draft"], ["posted", "Posted"]]} onChange={(v) => url.set({ status: v })} />}>
        {tab === "invoices" ? (
          <DataTable columns={invColumns} rows={invoices.data?.results} isLoading={invoices.isLoading} error={invoices.error} onRetry={invoices.refetch}
            rowHref={(i) => `/sales/invoices/${i.id}`} caption="Sales invoices"
            empty={<EmptyState icon={ReceiptIndianRupee} title="No invoices" description="Invoice an order once goods are delivered." />} />
        ) : (
          <DataTable columns={retColumns} rows={returns.data?.results} isLoading={returns.isLoading} error={returns.error} onRetry={returns.refetch}
            rowHref={(r) => `/sales/invoices/returns/${r.id}`} caption="Sales returns and credit notes"
            empty={<EmptyState icon={Undo2} title="No returns" />} />
        )}
        {active.data && <PageNav page={url.page} count={active.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
      {url.get("new") === "1" && <NewInvoice initialSo={url.get("so")} onClose={() => url.set({ new: null, so: null })} />}
      {url.get("newReturn") === "1" && <NewReturn initialInvoice={url.get("invoice")} onClose={() => url.set({ newReturn: null, invoice: null })} />}
    </>
  );
}
