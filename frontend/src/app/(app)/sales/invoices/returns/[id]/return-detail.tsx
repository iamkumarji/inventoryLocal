"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, DocStatus, Facts, Money } from "@/components/trade/common";
import { trim } from "@/components/trade/decimal";
import { Actions, useTradeAction } from "@/components/trade/layout";
import { Button } from "@/components/ui/button";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, useItemIndex, usePartnerIndex } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

type Line = components["schemas"]["SalesReturnLine"];

export function SalesReturnDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const scopes = useCompanyScopes();
  const customers = usePartnerIndex("customer");
  const items = useItemIndex();
  const query = useQuery({ queryKey: tradeKey("sales-returns", id), queryFn: () => unwrap(api.GET("/api/v1/sales/returns/{id}/", { params: { path: { id } } })) });
  const inv = useQuery({
    queryKey: tradeKey("invoices", query.data?.invoice),
    queryFn: () => unwrap(api.GET("/api/v1/sales/invoices/{id}/", { params: { path: { id: query.data!.invoice } } })),
    enabled: !!query.data,
  });
  const post = useTradeAction(() =>
    unwrap(api.POST("/api/v1/sales/returns/{id}/post/", { params: { path: { id }, header: { "Idempotency-Key": idempotencyKey() } }, body: { version: query.data!.version } })),
  (r) => toast(`Credit note ${r.number} issued`));
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const r = query.data!;
  const invLine = (lineId: string) => inv.data?.lines.find((l) => l.id === lineId);
  const columns: Column<Line>[] = [
    { key: "item", header: "Item", cell: (l) => <span className="num">{items.get(invLine(l.invoice_line)?.item)?.code ?? "—"}</span> },
    { key: "qty", header: "Returned", align: "right", cell: (l) => <span className="num">{trim(l.quantity)}</span> },
    { key: "restock", header: "Goes to", cell: (l) => (l.restock ? <StatusBadge tone="approved">Unrestricted stock</StatusBadge> : <StatusBadge tone="rejected">Blocked stock</StatusBadge>) },
  ];
  return (
    <>
      <PageHeader crumbs={[{ label: "Sales invoices", href: "/sales/invoices" }, { label: "Returns", href: "/sales/invoices?tab=returns" }, { label: r.number || "Draft" }]}
        title={r.number ? `Credit note ${r.number}` : "Draft sales return"}
        meta={<><DocStatus status={r.status} /><span>{customers.name(r.customer)}</span>{r.status === "posted" && <span className="num font-semibold">Credit <Money value={r.credit_total} /></span>}</>}
        actions={<Actions>{r.status === "draft" && can("sales.sales_return.post") && <Button onClick={() => post.mutate(undefined)} disabled={post.isPending}><CheckCheck aria-hidden /> Post and issue credit note</Button>}</Actions>} />
      <ActionError error={post.error} className="mb-4" />
      <div className="grid grid-cols-1 gap-6">
        <Section title="Lines"><DataTable columns={columns} rows={r.lines} caption="Return lines" /></Section>
        <Section title="Details">
          <Facts items={[
            ["Invoice", inv.data ? <Link key="i" className="num underline underline-offset-2" href={`/sales/invoices/${inv.data.id}`}>{inv.data.number}</Link> : "…"],
            ["Warehouse", scopes.name(r.warehouse)],
            ["Return date", date(r.return_date)],
            ["Reason", r.reason],
          ]} />
        </Section>
      </div>
    </>
  );
}
