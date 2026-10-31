"use client";

import { useQuery } from "@tanstack/react-query";
import { Ban, PackageCheck, Send } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, DocStatus, Facts, GstMode, Money, Notice, sumOf, Totals } from "@/components/trade/common";
import { dec0, trim } from "@/components/trade/decimal";
import { Actions, DecisionPanel, useTradeAction } from "@/components/trade/layout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, useUoms } from "@/lib/api/trade";
import { date, dateTime, money } from "@/lib/format";
import { useSession } from "@/lib/session";

import { APPROVER_HINTS } from "../../requisitions/[id]/requisition-detail";

type Line = components["schemas"]["PurchasePOLine"];

export function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const scopes = useCompanyScopes();
  const uoms = useUoms();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const query = useQuery({ queryKey: tradeKey("orders", id), queryFn: () => unwrap(api.GET("/api/v1/procurement/orders/{id}/", { params: { path: { id } } })) });
  const submit = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/orders/{id}/submit/", { params: { path: { id } }, body: { version: query.data!.version } })),
  () => toast("Submitted for approval"));
  const decide = useTradeAction(({ approve, comment }: { approve: boolean; comment: string }) =>
    unwrap(api.POST("/api/v1/procurement/orders/{id}/decide/", { params: { path: { id } }, body: { approve, comment, version: query.data!.version } })),
  (_d, v) => toast(v.approve ? "Purchase order approved" : "Purchase order rejected"));
  const cancel = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/orders/{id}/cancel/", { params: { path: { id } }, body: { approve: false, comment: reason, version: query.data!.version } })),
  () => { toast("Purchase order cancelled"); setCancelling(false); });

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const po = query.data!;
  const mine = po.created_by === me.user.id || po.submitted_by === me.user.id;
  const canDecide = can("procurement.purchase_order.approve") || can("procurement.purchase_order.reject");
  const anyReceived = po.lines.some((l) => dec0(l.received_quantity) > BigInt(0));
  const columns: Column<Line>[] = [
    { key: "item", header: "Item", cell: (l) => <span><span className="num block">{l.line_no}. {l.item_code}</span><span className="block max-w-[28ch] truncate text-xs text-muted-foreground">{l.item_name}</span></span> },
    { key: "qty", header: "Qty", align: "right", cell: (l) => <span className="num whitespace-nowrap">{trim(l.quantity)} {uoms.code(l.uom)}</span> },
    { key: "rate", header: "Rate", align: "right", cell: (l) => <Money value={l.rate} /> },
    { key: "disc", header: "Disc %", align: "right", cell: (l) => <span className="num">{trim(l.discount_pct ?? "0")}</span> },
    { key: "taxable", header: "Taxable", align: "right", cell: (l) => <Money value={l.taxable_amount} /> },
    { key: "gst", header: "GST %", align: "right", cell: (l) => <span className="num">{trim(l.gst_rate)}</span> },
    { key: "cgst", header: "CGST", align: "right", cell: (l) => <Money value={l.cgst} /> },
    { key: "sgst", header: "SGST", align: "right", cell: (l) => <Money value={l.sgst} /> },
    { key: "igst", header: "IGST", align: "right", cell: (l) => <Money value={l.igst} /> },
    { key: "recv", header: "Received", align: "right", cell: (l) => <span className="num whitespace-nowrap">{trim(l.received_quantity)}{dec0(l.returned_quantity) > BigInt(0) ? ` (−${trim(l.returned_quantity)})` : ""}</span> },
    { key: "wh", header: "Deliver to", cell: (l) => <span className="whitespace-nowrap">{scopes.name(l.warehouse)}{dec0(l.over_receipt_pct) > BigInt(0) ? <span className="block text-xs text-muted-foreground">+{trim(l.over_receipt_pct)}% tolerance</span> : null}</span> },
  ];
  return (
    <>
      <PageHeader crumbs={[{ label: "Purchase orders", href: "/procurement/orders" }, { label: po.number }]} title={`${po.number} · ${po.supplier_name}`}
        meta={<><DocStatus status={po.status} />{po.status === "approved" && <DocStatus status={po.receipt_status} label={po.receipt_status === "open" ? "Not received" : undefined} />}<span className="num font-semibold">Total <Money value={po.amount} /></span><GstMode intra={po.intra_state} /></>}
        actions={<Actions>
          {(po.status === "draft" || po.status === "rejected") && can("procurement.purchase_order.update") && (
            <Button onClick={() => submit.mutate(undefined)} disabled={submit.isPending}><Send aria-hidden /> Submit for approval</Button>
          )}
          {po.status === "approved" && po.receipt_status !== "received" && can("procurement.goods_receipt.create") && (
            <Button asChild><Link href={`/procurement/receipts?new=1&po=${po.id}`}><PackageCheck aria-hidden /> Receive goods</Link></Button>
          )}
          {!["cancelled", "closed"].includes(po.status) && !anyReceived && can("procurement.purchase_order.cancel") && (
            <Button variant="outline" onClick={() => { cancel.reset(); setCancelling(true); }}><Ban aria-hidden /> Cancel order</Button>
          )}
        </Actions>} />
      <ActionError error={submit.error} className="mb-4" />
      <div className="grid grid-cols-1 gap-6">
        {po.status === "submitted" && canDecide && !mine && (
          <DecisionPanel description="Approval checks your approval limit against the order total (including GST)." pending={decide.isPending}
            error={decide.error} hints={APPROVER_HINTS} onDecide={(approve, comment) => decide.mutate({ approve, comment })} />
        )}
        {po.status === "submitted" && mine && <Notice>You drafted or submitted this order, so someone else approves it (maker-checker).</Notice>}
        <Section title="Lines" description={po.intra_state ? "Supplier is in the same state: GST is split into CGST and SGST." : "Supplier is in another state: GST is charged as IGST."}>
          <DataTable columns={columns} rows={po.lines} caption="Purchase order lines" />
          <Totals rows={[["Subtotal (taxable)", po.subtotal], ["CGST", sumOf(po.lines, (l) => l.cgst)], ["SGST", sumOf(po.lines, (l) => l.sgst)], ["IGST", sumOf(po.lines, (l) => l.igst)]]}
            total={["Order total", po.amount]} note={`Tax ${money(po.tax_total)} · amounts from the server`} />
        </Section>
        <Section title="Details">
          <Facts items={[
            ["Supplier", po.supplier_name],
            ["Branch", scopes.name(po.branch)],
            ["Order date", date(po.order_date)],
            ["Expected by", date(po.expected_date)],
            ["Payment terms", `${po.payment_terms_days ?? "—"} days`],
            ["Revision", po.revision],
            ["Source", po.quotation ? "Selected quotation" : po.requisition ? "Requisition" : "Direct"],
            ["Created", `${dateTime(po.created_at)}${po.created_by === me.user.id ? " by you" : ""}`],
            ["Notes", po.notes || "—"],
          ]} />
        </Section>
      </div>
      <Dialog open={cancelling} onOpenChange={setCancelling}>
        <DialogContent className="sm:max-w-md">
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); cancel.mutate(undefined); }}>
            <DialogHeader><DialogTitle>Cancel {po.number}?</DialogTitle><DialogDescription>Orders with receipts can&apos;t be cancelled. The reason is recorded in the audit trail.</DialogDescription></DialogHeader>
            <ActionError error={cancel.error} />
            <Field id="po-cancel-reason" label="Reason"><Textarea id="po-cancel-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
            <DialogFooter><Button type="submit" variant="destructive" disabled={!reason.trim() || cancel.isPending}>Cancel order</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
