"use client";

import { useQuery } from "@tanstack/react-query";
import { PackageCheck, ReceiptIndianRupee, Send } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { ActionError, CreditStatus, DocStatus, Facts, GstMode, Money, Notice, sumOf, Totals } from "@/components/trade/common";
import { dec0, trim } from "@/components/trade/decimal";
import { Actions, DecisionPanel, useTradeAction } from "@/components/trade/layout";
import { stateName } from "@/components/trade/pickers";
import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, useItemIndex, useUoms } from "@/lib/api/trade";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

type Line = components["schemas"]["SalesOrderLine"];

export function SalesOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const { withStepUp } = useStepUp();
  const scopes = useCompanyScopes();
  const uoms = useUoms();
  const items = useItemIndex();
  const query = useQuery({ queryKey: tradeKey("sales-orders", id), queryFn: () => unwrap(api.GET("/api/v1/sales/orders/{id}/", { params: { path: { id } } })) });
  const submit = useTradeAction(() =>
    unwrap(api.POST("/api/v1/sales/orders/{id}/submit/", { params: { path: { id } }, body: { version: query.data!.version } })),
  (so) => (so.credit_status === "ok"
    ? toast("Credit check passed: order approved and stock reserved")
    : toast.warning(`Credit blocked: ${so.credit_note}`)));
  const credit = useTradeAction(({ approve, note }: { approve: boolean; note: string }) =>
    withStepUp(() => unwrap(api.POST("/api/v1/sales/orders/{id}/credit/", { params: { path: { id } }, body: { approve, note } }))),
  (_d, v) => toast(v.approve ? "Credit overridden: order approved and stock reserved" : "Credit block upheld: order rejected"));

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const so = query.data!;
  // The order doesn't expose its creator, only who submitted it; the server also refuses the creator.
  const isMaker = so.submitted_by === me.user.id;
  const zero = BigInt(0);
  const undelivered = so.lines.some((l) => dec0(l.stock_quantity) > dec0(l.delivered_quantity));
  const uninvoiced = so.lines.some((l) => dec0(l.delivered_quantity) > dec0(l.invoiced_quantity));
  const columns: Column<Line>[] = [
    { key: "item", header: "Item", cell: (l) => <span><span className="num block">{l.line_no}. {l.item_code}</span><span className="block max-w-[26ch] truncate text-xs text-muted-foreground">{items.get(l.item)?.name}</span></span> },
    { key: "qty", header: "Qty", align: "right", cell: (l) => <span className="num whitespace-nowrap">{trim(l.quantity)} {uoms.code(l.uom)}</span> },
    { key: "rate", header: "Rate", align: "right", cell: (l) => <Money value={l.rate} /> },
    { key: "taxable", header: "Taxable", align: "right", cell: (l) => <Money value={l.taxable_amount} /> },
    { key: "gst", header: "GST %", align: "right", cell: (l) => <span className="num">{trim(l.gst_rate)}</span> },
    { key: "cgst", header: "CGST", align: "right", cell: (l) => <Money value={l.cgst} /> },
    { key: "sgst", header: "SGST", align: "right", cell: (l) => <Money value={l.sgst} /> },
    { key: "igst", header: "IGST", align: "right", cell: (l) => <Money value={l.igst} /> },
    { key: "reserved", header: "Reserved", align: "right", cell: (l) => (
      <span className={`num whitespace-nowrap ${dec0(l.reserved_quantity) > zero ? "font-semibold text-status-info" : ""}`}>
        {trim(l.reserved_quantity)} <span className="text-xs font-normal text-muted-foreground">of {trim(l.stock_quantity)} {items.get(l.item)?.stock_uom_code}</span>
      </span>) },
    { key: "delivered", header: "Delivered", align: "right", cell: (l) => <span className="num">{trim(l.delivered_quantity)}</span> },
    { key: "invoiced", header: "Invoiced", align: "right", cell: (l) => <span className="num">{trim(l.invoiced_quantity)}</span> },
    { key: "wh", header: "Ship from", cell: (l) => <span className="whitespace-nowrap">{scopes.name(l.warehouse)}</span> },
  ];
  const blocked = so.status === "submitted" && so.credit_status === "blocked";
  return (
    <>
      <PageHeader crumbs={[{ label: "Sales orders", href: "/sales/orders" }, { label: so.number }]} title={`${so.number} · ${so.customer_name}`}
        meta={<><DocStatus status={so.status} /><CreditStatus status={so.credit_status} /><span className="num font-semibold">Total <Money value={so.amount} /></span><GstMode intra={so.intra_state} /></>}
        actions={<Actions>
          {(so.status === "draft" || so.status === "rejected") && can("sales.sales_order.update") && (
            <Button onClick={() => submit.mutate(undefined)} disabled={submit.isPending}><Send aria-hidden /> Submit order</Button>
          )}
          {so.status === "approved" && undelivered && can("sales.delivery.create") && (
            <Button asChild><Link href={`/sales/deliveries?new=1&so=${so.id}`}><PackageCheck aria-hidden /> Create delivery</Link></Button>
          )}
          {so.status === "approved" && uninvoiced && can("sales.invoice.create") && (
            <Button variant="outline" asChild><Link href={`/sales/invoices?new=1&so=${so.id}`}><ReceiptIndianRupee aria-hidden /> Create invoice</Link></Button>
          )}
        </Actions>} />
      <ActionError error={submit.error} className="mb-4" />
      <div className="grid grid-cols-1 gap-6">
        {so.credit_note && (
          <Notice tone={so.credit_status === "blocked" ? "rejected" : "info"}>
            <span className="font-medium">Credit check: </span>{so.credit_note}
          </Notice>
        )}
        {blocked && can("sales.sales_order.credit_override") && !isMaker && (
          <DecisionPanel title="Credit decision" description="Override to approve the order and reserve stock, or uphold the block to reject it. Needs a fresh two-step verification."
            approveLabel="Override and approve" rejectLabel="Uphold block" noteLabel="Reason" noteRequired pending={credit.isPending} error={credit.error}
            hints={{ permission_denied: "You can't decide on credit for this order: you need credit override authority." }}
            onDecide={(approve, note) => credit.mutate({ approve, note })} />
        )}
        {blocked && isMaker && <Notice>The order is waiting for a credit decision by someone with credit authority other than you.</Notice>}
        <Section title="Lines" description="Reserved quantities are held in stock units for this order until delivered.">
          <DataTable columns={columns} rows={so.lines} caption="Sales order lines" />
          <Totals rows={[["Subtotal (taxable)", so.subtotal], ["CGST", sumOf(so.lines, (l) => l.cgst)], ["SGST", sumOf(so.lines, (l) => l.sgst)], ["IGST", sumOf(so.lines, (l) => l.igst)]]}
            total={["Order total", so.amount]} note="Amounts from the server" />
        </Section>
        <Section title="Details">
          <Facts items={[
            ["Customer", <Link key="c" className="underline underline-offset-2" href={`/partners/customers/${so.customer}`}>{so.customer_name}</Link>],
            ["Branch", scopes.name(so.branch)],
            ["Order date", date(so.order_date)],
            ["Requested", date(so.requested_date)],
            ["Place of supply", `${so.place_of_supply} · ${stateName(so.place_of_supply)}`],
            ["Customer PO", so.customer_po || "—"],
            ["Created", dateTime(so.created_at)],
            ["Submitted", so.submitted_by ? (so.submitted_by === me.user.id ? "By you" : "By a colleague") : "Not yet"],
          ]} />
        </Section>
      </div>
    </>
  );
}
