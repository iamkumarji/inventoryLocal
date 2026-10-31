"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, Send } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, DocStatus, Facts, Money, Notice } from "@/components/trade/common";
import { trim } from "@/components/trade/decimal";
import { Actions, DecisionPanel, useTradeAction } from "@/components/trade/layout";
import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, useItemIndex, useUoms } from "@/lib/api/trade";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

type Line = components["schemas"]["PurchasePRLine"];

export const APPROVER_HINTS = {
  permission_denied: "You can't decide this. Approving needs an approval limit that covers the amount, and nobody can approve a document they raised or submitted.",
};

export function RequisitionDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const scopes = useCompanyScopes();
  const uoms = useUoms();
  const items = useItemIndex();
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
    </>
  );
}
