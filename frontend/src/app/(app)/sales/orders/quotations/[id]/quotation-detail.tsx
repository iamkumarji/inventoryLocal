"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, DocStatus, Facts, GstMode, Money, sumOf, Totals, today } from "@/components/trade/common";
import { trim } from "@/components/trade/decimal";
import { useTradeAction } from "@/components/trade/layout";
import { WarehouseSelect } from "@/components/trade/pickers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, usePartnerIndex, useUoms } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

type Line = components["schemas"]["SalesQuoteLine"];

export function QuotationDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useSession();
  const scopes = useCompanyScopes();
  const customers = usePartnerIndex("customer");
  const uoms = useUoms();
  const [converting, setConverting] = useState(false);
  const [form, setForm] = useState({ warehouse: "", order_date: today(), requested_date: today(7) });
  const query = useQuery({ queryKey: tradeKey("quotations", id), queryFn: () => unwrap(api.GET("/api/v1/sales/quotations/{id}/", { params: { path: { id } } })) });
  const convert = useTradeAction(() => unwrap(api.POST("/api/v1/sales/quotations/{id}/convert/", { params: { path: { id } }, body: form })),
    (so) => { toast(`${so.number} created from the quotation`); router.push(`/sales/orders/${so.id}`); });
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const q = query.data!;
  const columns: Column<Line>[] = [
    { key: "item", header: "Item", cell: (l) => <span className="num">{l.item_code}</span> },
    { key: "qty", header: "Qty", align: "right", cell: (l) => <span className="num">{trim(l.quantity)} {uoms.code(l.uom)}</span> },
    { key: "rate", header: "Rate", align: "right", cell: (l) => <Money value={l.rate} /> },
    { key: "disc", header: "Disc %", align: "right", cell: (l) => <span className="num">{trim(l.discount_pct ?? "0")}</span> },
    { key: "taxable", header: "Taxable", align: "right", cell: (l) => <Money value={l.taxable_amount} /> },
    { key: "cgst", header: "CGST", align: "right", cell: (l) => <Money value={l.cgst} /> },
    { key: "sgst", header: "SGST", align: "right", cell: (l) => <Money value={l.sgst} /> },
    { key: "igst", header: "IGST", align: "right", cell: (l) => <Money value={l.igst} /> },
  ];
  return (
    <>
      <PageHeader crumbs={[{ label: "Sales orders", href: "/sales/orders" }, { label: "Quotations", href: "/sales/orders?tab=quotations" }, { label: q.number }]}
        title={`Quotation ${q.number}`} meta={<><DocStatus status={q.status} /><span>{customers.name(q.customer)}</span><span className="num font-semibold">Total <Money value={q.amount} /></span><GstMode intra={q.intra_state} /></>}
        actions={q.status === "open" && can("sales.sales_order.create") && <Button onClick={() => setConverting(true)}><ArrowRightLeft aria-hidden /> Convert to order</Button>} />
      <div className="grid grid-cols-1 gap-6">
        <Section title="Lines">
          <DataTable columns={columns} rows={q.lines} caption="Quotation lines" />
          <Totals rows={[["Subtotal", sumOf(q.lines, (l) => l.taxable_amount)], ["CGST", sumOf(q.lines, (l) => l.cgst)], ["SGST", sumOf(q.lines, (l) => l.sgst)], ["IGST", sumOf(q.lines, (l) => l.igst)]]} total={["Total", q.amount]} />
        </Section>
        <Section title="Details">
          <Facts items={[["Branch", scopes.name(q.branch)], ["Quoted", date(q.quote_date)], ["Valid until", date(q.valid_until)], ["Notes", q.notes || "—"]]} />
        </Section>
      </div>
      <Dialog open={converting} onOpenChange={setConverting}>
        <DialogContent className="sm:max-w-md">
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); convert.mutate(undefined); }}>
            <DialogHeader><DialogTitle>Convert to sales order</DialogTitle><DialogDescription>Creates a draft order at the quoted prices. Submit it to run the credit check.</DialogDescription></DialogHeader>
            <ActionError error={convert.error} />
            <Field id="cv-wh" label="Ship from"><WarehouseSelect id="cv-wh" branchId={q.branch} value={form.warehouse} onChange={(v) => setForm({ ...form, warehouse: v })} /></Field>
            <Field id="cv-date" label="Order date"><Input id="cv-date" type="date" value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} /></Field>
            <Field id="cv-req" label="Requested delivery"><Input id="cv-req" type="date" value={form.requested_date} onChange={(e) => setForm({ ...form, requested_date: e.target.value })} /></Field>
            <DialogFooter><Button type="submit" disabled={!form.warehouse || convert.isPending}>Create order</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
