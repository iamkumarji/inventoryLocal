"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCheck, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, DocStatus, Facts, Money, Notice } from "@/components/trade/common";
import { trim } from "@/components/trade/decimal";
import { Actions, useTradeAction } from "@/components/trade/layout";
import { Button } from "@/components/ui/button";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, useItemIndex, useUoms } from "@/lib/api/trade";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

type Line = components["schemas"]["PurchaseGRNLine"];

export function ReceiptDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const scopes = useCompanyScopes();
  const uoms = useUoms();
  const items = useItemIndex();
  const query = useQuery({ queryKey: tradeKey("receipts", id), queryFn: () => unwrap(api.GET("/api/v1/procurement/receipts/{id}/", { params: { path: { id } } })) });
  const po = useQuery({
    queryKey: tradeKey("orders", query.data?.purchase_order),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/orders/{id}/", { params: { path: { id: query.data!.purchase_order } } })),
    enabled: !!query.data,
  });
  const post = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/receipts/{id}/post/", {
      params: { path: { id }, header: { "Idempotency-Key": idempotencyKey() } }, body: { version: query.data!.version },
    })),
  (g) => toast(`${g.number} posted. Stock is in${g.lines.some((l) => l.inspection) ? "; inspected items are on quality hold" : ""}.`));

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const g = query.data!;
  const poLine = (lineId: string) => po.data?.lines.find((l) => l.id === lineId);
  const posted = g.status === "posted";
  const columns: Column<Line>[] = [
    { key: "item", header: "Item", cell: (l) => <span><span className="num block">{l.item_code}</span><span className="block text-xs text-muted-foreground">{poLine(l.po_line)?.item_name}</span></span> },
    { key: "qty", header: "Received", align: "right", cell: (l) => <span className="num whitespace-nowrap">{trim(l.quantity)} {uoms.code(poLine(l.po_line)?.uom)}</span> },
    { key: "stock", header: "Stock qty", align: "right", cell: (l) => {
      const item = items.get(poLine(l.po_line)?.item);
      return <span className="num whitespace-nowrap">{posted ? `${trim(l.stock_quantity)} ${item?.stock_uom_code ?? ""}` : "On posting"}</span>;
    } },
    { key: "cost", header: "Unit cost", align: "right", cell: (l) => (posted ? <Money value={l.unit_cost} /> : <span className="text-muted-foreground">—</span>) },
    { key: "batch", header: "Batch", cell: (l) => <span className="num">{l.batch_number || "—"}{l.expires_on ? <span className="block text-xs text-muted-foreground">exp {date(l.expires_on)}</span> : null}</span> },
    { key: "qc", header: "Stock status", cell: (l) => {
      if (posted) return l.inspection ? <StatusBadge tone="pending">Quality hold</StatusBadge> : <StatusBadge tone="approved">Unrestricted</StatusBadge>;
      return items.get(poLine(l.po_line)?.item)?.inspection_required ? <span className="text-xs text-status-pending">Will go to quality hold</span> : <span className="text-muted-foreground">—</span>;
    } },
  ];
  return (
    <>
      <PageHeader crumbs={[{ label: "Goods receipts", href: "/procurement/receipts" }, { label: g.number || "Draft" }]}
        title={g.number ? `Receipt ${g.number}` : "Draft goods receipt"}
        meta={<><DocStatus status={g.status} /><span>{g.supplier_name}</span><span className="text-muted-foreground">{date(g.receipt_date)}</span></>}
        actions={<Actions>
          {g.status === "draft" && can("procurement.goods_receipt.post") && (
            <Button onClick={() => post.mutate(undefined)} disabled={post.isPending}><CheckCheck aria-hidden /> Post receipt</Button>
          )}
          {posted && can("procurement.purchase_return.create") && (
            <Button variant="outline" asChild><Link href={`/procurement/receipts?tab=returns&newReturn=1&grn=${g.id}`}><Undo2 aria-hidden /> Return goods</Link></Button>
          )}
        </Actions>} />
      <ActionError error={post.error} className="mb-4" />
      <div className="grid grid-cols-1 gap-6">
        {posted && g.lines.some((l) => l.inspection) && (
          <Notice tone="pending">Some items need inspection. They sit in quality-hold stock and can&apos;t be issued or sold until quality releases them.</Notice>
        )}
        <Section title="Lines" description="Quantities in the order's unit; stock quantities and costs are fixed on posting.">
          <DataTable columns={columns} rows={g.lines} caption="Goods receipt lines" />
        </Section>
        <Section title="Details">
          <Facts items={[
            ["Purchase order", po.data ? <Link className="num underline underline-offset-2" href={`/procurement/orders/${po.data.id}`}>{po.data.number}</Link> : "…"],
            ["Warehouse", scopes.name(g.warehouse)],
            ["Delivery note", g.supplier_delivery_note || "—"],
            ["Vehicle", g.vehicle_number || "—"],
            ["Created", dateTime(g.created_at)],
            ["Posted", posted ? (g.posted_by === me.user.id ? "By you" : "Yes") : "Not yet"],
          ]} />
        </Section>
      </div>
    </>
  );
}
