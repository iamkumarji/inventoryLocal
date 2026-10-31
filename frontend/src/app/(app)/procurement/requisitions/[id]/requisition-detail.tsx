"use client";

import { useQuery } from "@tanstack/react-query";
import { Ban, FileText, Send } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, DocStatus, Facts, Money, Notice } from "@/components/trade/common";
import { trim } from "@/components/trade/decimal";
import { Actions, DecisionPanel, useTradeAction } from "@/components/trade/layout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, useItemIndex, useUoms } from "@/lib/api/trade";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

type Line = components["schemas"]["PurchasePRLine"];

export const APPROVER_HINTS = {
  permission_denied: "You can't decide this: you need approval rights for this document in this branch.",
};

export function RequisitionDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const scopes = useCompanyScopes();
  const uoms = useUoms();
  const items = useItemIndex();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const query = useQuery({
    queryKey: tradeKey("requisitions", id),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/requisitions/{id}/", { params: { path: { id } } })),
  });
  const submit = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/requisitions/{id}/submit/", { params: { path: { id } }, body: { version: query.data!.version } })),
  () => toast("Submitted for approval"));
  const decide = useTradeAction(({ approve, comment }: { approve: boolean; comment: string }) =>
    unwrap(api.POST("/api/v1/procurement/requisitions/{id}/decide/", { params: { path: { id } }, body: { approve, comment, version: query.data!.version } })),
  (_d, v) => toast(v.approve ? "Requisition approved" : "Requisition rejected"));
  const cancel = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/requisitions/{id}/cancel/", { params: { path: { id } }, body: { reason } })),
  () => { toast("Requisition cancelled"); setCancelling(false); setReason(""); });

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const pr = query.data!;
  const mine = pr.created_by === me.user.id || pr.submitted_by === me.user.id;
  const canDecide = can("procurement.purchase_requisition.approve") || can("procurement.purchase_requisition.reject");
  const columns: Column<Line>[] = [
    { key: "item", header: "Item", cell: (l) => <span><span className="num block">{l.item_code}</span><span className="block text-xs text-muted-foreground">{items.get(l.item)?.name}</span></span> },
    { key: "qty", header: "Quantity", align: "right", cell: (l) => <span className="num">{trim(l.quantity)} {uoms.code(l.uom)}</span> },
    { key: "rate", header: "Est. rate", align: "right", cell: (l) => <Money value={l.estimated_rate} /> },
    { key: "wh", header: "Deliver to", cell: (l) => scopes.name(l.warehouse) },
    { key: "ordered", header: "Ordered", align: "right", cell: (l) => <span className="num">{trim(l.ordered_quantity)}</span> },
  ];

  return (
    <>
      <PageHeader crumbs={[{ label: "Requisitions", href: "/procurement/requisitions" }, { label: pr.number }]} title={pr.purpose}
        meta={<><span className="num font-medium">{pr.number}</span><DocStatus status={pr.status} /><span className="text-muted-foreground">Estimate <Money value={pr.amount} /></span></>}
        actions={<Actions>
          {(pr.status === "draft" || pr.status === "rejected") && can("procurement.purchase_requisition.update") && (
            <Button onClick={() => submit.mutate(undefined)} disabled={submit.isPending}><Send aria-hidden /> Submit for approval</Button>
          )}
          {pr.status === "approved" && can("procurement.rfq.create") && (
            <Button variant="outline" asChild><Link href={`/procurement/rfqs?new=1&requisition=${pr.id}`}><FileText aria-hidden /> Request quotations</Link></Button>
          )}
          {["draft", "rejected", "approved"].includes(pr.status) && can("procurement.purchase_requisition.cancel") && (
            <Button variant="outline" onClick={() => { cancel.reset(); setCancelling(true); }}><Ban aria-hidden /> Cancel requisition</Button>
          )}
        </Actions>} />
      <ActionError error={submit.error} className="mb-4" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <Section title="Items" description="Estimated rates are for budgeting; prices come from quotations or the purchase order.">
            <DataTable columns={columns} rows={pr.lines} caption="Requisition items" />
          </Section>
        </div>
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          {pr.status === "submitted" && canDecide && !mine && (
            <DecisionPanel description="Approval checks your approval limit against the estimate." pending={decide.isPending} error={decide.error}
              hints={APPROVER_HINTS} onDecide={(approve, comment) => decide.mutate({ approve, comment })} />
          )}
          {pr.status === "submitted" && mine && <Notice>You raised this requisition, so someone else approves it (maker-checker).</Notice>}
          <Section title="Details">
            <Facts className="sm:grid-cols-[minmax(7rem,auto)_minmax(0,1fr)]" items={[
              ["Branch", scopes.name(pr.branch)],
              ["Department", pr.department ? scopes.name(pr.department) : "—"],
              ["Needed by", date(pr.needed_by)],
              ["Raised", `${dateTime(pr.created_at)}${pr.created_by === me.user.id ? " by you" : ""}`],
              ["Submitted", pr.submitted_by ? (pr.submitted_by === me.user.id ? "By you" : "By a colleague") : "Not yet"],
              ["Approved", pr.approved_by ? (pr.approved_by === me.user.id ? "By you" : "By a colleague") : "—"],
            ]} />
          </Section>
        </div>
      </div>
      <Dialog open={cancelling} onOpenChange={setCancelling}>
        <DialogContent className="sm:max-w-md">
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); cancel.mutate(undefined); }}>
            <DialogHeader>
              <DialogTitle>Cancel {pr.number}?</DialogTitle>
              <DialogDescription>A cancelled requisition can&apos;t be ordered against. Requisitions with RFQs or orders can&apos;t be cancelled. The reason is recorded in the audit trail.</DialogDescription>
            </DialogHeader>
            <ActionError error={cancel.error} />
            <Field id="pr-cancel-reason" label="Reason"><Textarea id="pr-cancel-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
            <DialogFooter><Button type="submit" variant="destructive" disabled={!reason.trim() || cancel.isPending}>Cancel requisition</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
