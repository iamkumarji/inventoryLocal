"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCheck, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, DocStatus, Facts, GstMode, Money, Totals } from "@/components/trade/common";
import { trim } from "@/components/trade/decimal";
import { Actions, useTradeAction } from "@/components/trade/layout";
import { stateName } from "@/components/trade/pickers";
import { Button } from "@/components/ui/button";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, useItemIndex } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

type Line = components["schemas"]["SalesInvoiceLine"];

export function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const scopes = useCompanyScopes();
  const items = useItemIndex();
  const query = useQuery({ queryKey: tradeKey("invoices", id), queryFn: () => unwrap(api.GET("/api/v1/sales/invoices/{id}/", { params: { path: { id } } })) });
  const so = useQuery({
    queryKey: tradeKey("sales-orders", query.data?.sales_order),
    queryFn: () => unwrap(api.GET("/api/v1/sales/orders/{id}/", { params: { path: { id: query.data!.sales_order } } })),
    enabled: !!query.data,
  });
  const post = useTradeAction(() =>
    unwrap(api.POST("/api/v1/sales/invoices/{id}/post/", { params: { path: { id }, header: { "Idempotency-Key": idempotencyKey() } }, body: { version: query.data!.version } })),
  (inv) => toast(`Invoice ${inv.number} posted to receivables`));
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const inv = query.data!;
  const posted = inv.status === "posted";
  const columns: Column<Line>[] = [
    { key: "item", header: "Item", cell: (l) => <span><span className="num block">{items.get(l.item)?.code ?? "—"}</span><span className="block text-xs text-muted-foreground">HSN {l.hsn_code || "—"}</span></span> },
    { key: "qty", header: "Qty", align: "right", cell: (l) => <span className="num whitespace-nowrap">{trim(l.quantity)} {items.get(l.item)?.stock_uom_code}</span> },
    { key: "rate", header: "Rate", align: "right", cell: (l) => <Money value={l.rate} /> },
    { key: "taxable", header: "Taxable", align: "right", cell: (l) => <Money value={l.taxable_amount} /> },
    { key: "gst", header: "GST %", align: "right", cell: (l) => <span className="num">{trim(l.gst_rate)}</span> },
    { key: "cgst", header: "CGST", align: "right", cell: (l) => <Money value={l.cgst} /> },
    { key: "sgst", header: "SGST", align: "right", cell: (l) => <Money value={l.sgst} /> },
    { key: "igst", header: "IGST", align: "right", cell: (l) => <Money value={l.igst} /> },
    { key: "ret", header: "Returned", align: "right", cell: (l) => <span className="num">{trim(l.returned_quantity)}</span> },
  ];
  return (
    <>
      <PageHeader crumbs={[{ label: "Sales invoices", href: "/sales/invoices" }, { label: inv.number || "Draft" }]}
        title={inv.number ? `Invoice ${inv.number}` : "Draft invoice"}
        meta={<><DocStatus status={inv.status} /><span>{inv.customer_name}</span><span className="num font-semibold">Total <Money value={inv.total} /></span><GstMode intra={inv.intra_state} /></>}
        actions={<Actions>
          {inv.status === "draft" && can("sales.invoice.post") && <Button onClick={() => post.mutate(undefined)} disabled={post.isPending}><CheckCheck aria-hidden /> Post invoice</Button>}
          {posted && can("sales.sales_return.create") && <Button variant="outline" asChild><Link href={`/sales/invoices?tab=returns&newReturn=1&invoice=${inv.id}`}><Undo2 aria-hidden /> Record return</Link></Button>}
        </Actions>} />
      <ActionError error={post.error} className="mb-4" />
      {!posted && <p className="mb-4 text-sm text-muted-foreground">The invoice number is assigned from the gapless GST series when the invoice is posted.</p>}
      <div className="grid grid-cols-1 gap-6">
        <Section title="Lines" description="Quantities and rates are per stock unit.">
          <DataTable columns={columns} rows={inv.lines} caption="Invoice lines" />
          <Totals rows={[["Taxable value", inv.subtotal], ["CGST", inv.cgst], ["SGST", inv.sgst], ["IGST", inv.igst]]} total={["Invoice total", inv.total]} />
        </Section>
        <Section title="Details">
          <Facts items={[
            ["Customer", inv.customer_name],
            ["Customer GSTIN", <span key="g" className="num">{inv.customer_gstin || "Unregistered"}</span>],
            ["Place of supply", `${inv.place_of_supply} · ${stateName(inv.place_of_supply)}`],
            ["Branch", scopes.name(inv.branch)],
            ["Invoice date", date(inv.invoice_date)],
            ["Due date", date(inv.due_date)],
            ["Sales order", so.data ? <Link key="so" className="num underline underline-offset-2" href={`/sales/orders/${so.data.id}`}>{so.data.number}</Link> : "…"],
            ["E-invoice IRN", inv.irn || "—"],
            ["Ledger", inv.journal_entry ? "Posted to receivables and GST output" : "Not posted"],
          ]} />
        </Section>
      </div>
    </>
  );
}
