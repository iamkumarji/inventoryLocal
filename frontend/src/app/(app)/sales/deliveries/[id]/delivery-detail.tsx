"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCheck, Truck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, DocStatus, Facts, Money, sumOf } from "@/components/trade/common";
import { trim } from "@/components/trade/decimal";
import { Actions, useTradeAction } from "@/components/trade/layout";
import { Button } from "@/components/ui/button";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, useItemIndex, usePartnerIndex } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

type Line = components["schemas"]["SalesDeliveryLine"];

export function DeliveryDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const scopes = useCompanyScopes();
  const customers = usePartnerIndex("customer");
  const items = useItemIndex();
  const query = useQuery({ queryKey: tradeKey("deliveries", id), queryFn: () => unwrap(api.GET("/api/v1/sales/deliveries/{id}/", { params: { path: { id } } })) });
  const so = useQuery({
    queryKey: tradeKey("sales-orders", query.data?.sales_order),
    queryFn: () => unwrap(api.GET("/api/v1/sales/orders/{id}/", { params: { path: { id: query.data!.sales_order } } })),
    enabled: !!query.data,
  });
  const post = useTradeAction(() =>
    unwrap(api.POST("/api/v1/sales/deliveries/{id}/post/", { params: { path: { id }, header: { "Idempotency-Key": idempotencyKey() } }, body: { version: query.data!.version } })),
  (d) => toast(`Delivery ${d.number} posted. Stock issued and cost of goods sold booked.`));
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const d = query.data!;
  const posted = d.status === "posted";
  const soLine = (lineId: string) => so.data?.lines.find((l) => l.id === lineId);
  const columns: Column<Line>[] = [
    { key: "item", header: "Item", cell: (l) => <span className="num">{l.item_code}</span> },
    { key: "qty", header: "Quantity", align: "right", cell: (l) => <span className="num">{trim(l.quantity)} {items.get(soLine(l.so_line)?.item)?.stock_uom_code}</span> },
    { key: "batch", header: "Batch", cell: (l) => (l.batch ? "Batch picked" : <span className="text-muted-foreground">—</span>) },
    { key: "cost", header: "Cost of goods", align: "right", cell: (l) => (posted ? <Money value={l.cost_value} /> : <span className="text-muted-foreground">On posting</span>) },
  ];
  return (
    <>
      <PageHeader crumbs={[{ label: "Deliveries", href: "/sales/deliveries" }, { label: d.number || "Draft" }]} title={d.number ? `Delivery ${d.number}` : "Draft delivery"}
        meta={<><DocStatus status={d.status} /><span>{customers.name(d.customer)}</span><span className="text-muted-foreground">{date(d.delivery_date)}</span></>}
        actions={<Actions>
          {d.status === "draft" && can("sales.delivery.post") && <Button onClick={() => post.mutate(undefined)} disabled={post.isPending}><CheckCheck aria-hidden /> Post delivery</Button>}
          {posted && can("logistics.shipment.create") && <Button variant="outline" asChild><Link href={`/logistics/shipments?new=1&delivery=${d.id}`}><Truck aria-hidden /> Plan shipment</Link></Button>}
        </Actions>} />
      <ActionError error={post.error} className="mb-4" />
      <div className="grid grid-cols-1 gap-6">
        <Section title="Lines" description={posted ? `Cost of goods sold booked on the server: ₹${sumOf(d.lines, (l) => l.cost_value)}` : "Stock and cost of goods sold are booked when the delivery is posted."}>
          <DataTable columns={columns} rows={d.lines} caption="Delivery lines" />
        </Section>
        <Section title="Details">
          <Facts items={[
            ["Sales order", so.data ? <Link className="num underline underline-offset-2" href={`/sales/orders/${so.data.id}`}>{so.data.number}</Link> : "…"],
            ["Customer", customers.name(d.customer)],
            ["Ship from", scopes.name(d.warehouse)],
            ["E-way bill", d.eway_bill_number || "—"],
          ]} />
        </Section>
      </div>
    </>
  );
}
