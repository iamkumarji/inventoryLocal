"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, DocStatus, Facts, humanize } from "@/components/trade/common";
import { trim } from "@/components/trade/decimal";
import { Actions, useTradeAction } from "@/components/trade/layout";
import { Button } from "@/components/ui/button";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, usePartnerIndex } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

type Line = components["schemas"]["PurchaseReturnLine"];

export function PurchaseReturnDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const scopes = useCompanyScopes();
  const suppliers = usePartnerIndex("supplier");
  const query = useQuery({ queryKey: tradeKey("purchase-returns", id), queryFn: () => unwrap(api.GET("/api/v1/procurement/returns/{id}/", { params: { path: { id } } })) });
  const grn = useQuery({
    queryKey: tradeKey("receipts", query.data?.receipt),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/receipts/{id}/", { params: { path: { id: query.data!.receipt } } })),
    enabled: !!query.data,
  });
  const post = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/returns/{id}/post/", { params: { path: { id }, header: { "Idempotency-Key": idempotencyKey() } }, body: { version: query.data!.version } })),
  (r) => toast(`Return ${r.number} posted`));
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const r = query.data!;
  const grnLine = (lineId: string) => grn.data?.lines.find((l) => l.id === lineId);
  const columns: Column<Line>[] = [
    { key: "item", header: "Item", cell: (l) => <span className="num">{grnLine(l.receipt_line)?.item_code ?? "—"}</span> },
    { key: "qty", header: "Returned", align: "right", cell: (l) => <span className="num">{trim(l.quantity)}</span> },
    { key: "from", header: "From stock", cell: (l) => humanize(l.from_status || "unrestricted") },
  ];
  return (
    <>
      <PageHeader crumbs={[{ label: "Goods receipts", href: "/procurement/receipts" }, { label: "Returns", href: "/procurement/receipts?tab=returns" }, { label: r.number || "Draft" }]}
        title={r.number ? `Return ${r.number}` : "Draft purchase return"}
        meta={<><DocStatus status={r.status} /><span>{suppliers.name(r.supplier)}</span><span className="text-muted-foreground">{date(r.return_date)}</span></>}
        actions={<Actions>{r.status === "draft" && can("procurement.purchase_return.post") && <Button onClick={() => post.mutate(undefined)} disabled={post.isPending}><CheckCheck aria-hidden /> Post return</Button>}</Actions>} />
      <ActionError error={post.error} className="mb-4" />
      <div className="grid grid-cols-1 gap-6">
        <Section title="Lines"><DataTable columns={columns} rows={r.lines} caption="Return lines" /></Section>
        <Section title="Details">
          <Facts items={[
            ["Against receipt", grn.data ? <Link className="num underline underline-offset-2" href={`/procurement/receipts/${grn.data.id}`}>{grn.data.number}</Link> : "…"],
            ["Warehouse", scopes.name(r.warehouse)],
            ["Reason", r.reason],
          ]} />
        </Section>
      </div>
    </>
  );
}
