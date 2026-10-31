"use client";

import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { DataTable, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ANY, FilterBar, ItemPicker, WarehouseSelect } from "@/components/inventory/bits";
import { qty, signedQty } from "@/components/inventory/decimal";
import { InvStatus } from "@/components/inventory/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { cursorFrom, MOVEMENT_LABELS, useItem, type Ledger } from "@/lib/api/inventory";
import { date, money } from "@/lib/format";
import { useUrlState } from "@/lib/use-url-state";

const SOURCES: Record<string, { label: string; href?: (id: string) => string }> = {
  "inventory.stock_adjustment": { label: "Adjustment", href: (id) => `/inventory/adjustments/${id}` },
  "inventory.stock_transfer": { label: "Transfer", href: (id) => `/inventory/transfers/${id}` },
  "inventory.stock_count": { label: "Stock count", href: (id) => `/inventory/counts/${id}` },
  "quality.inspection": { label: "Inspection", href: (id) => `/quality?inspection=${id}` },
  "procurement.goods_receipt": { label: "Goods receipt" },
  "manufacturing.production_order": { label: "Production order" },
};

function Source({ row }: { row: Ledger }) {
  const s = SOURCES[row.source_type];
  const label = s?.label ?? row.source_type.split(".").pop()?.replace(/_/g, " ");
  return s?.href ? <Link className="underline-offset-4 hover:underline" href={s.href(row.source_id)}>{label}</Link> : <span>{label}</span>;
}

export function LedgerView() {
  const url = useUrlState();
  const item = url.get("item");
  const warehouse = url.get("warehouse");
  const movement = url.get("movement");
  const from = url.get("from");
  const to = url.get("to");
  const sourceId = url.get("source_id");
  const cursor = url.get("cursor");
  const size = ["10", "25", "50", "100"].includes(url.get("size")) ? url.get("size") : "50";
  const itemQuery = useItem(item || null);
  const query = useQuery({
    queryKey: ["inventory", "ledger", item, warehouse, movement, from, to, sourceId, cursor, size],
    queryFn: () => unwrap(api.GET("/api/v1/inventory/ledger/", {
      params: { query: {
        item: item || undefined, warehouse: warehouse || undefined, movement_type: movement || undefined,
        posting_date__gte: from || undefined, posting_date__lte: to || undefined, source_id: sourceId || undefined,
        cursor: cursor || undefined, page_size: Number(size),
      } },
    })),
    placeholderData: (previous) => previous,
  });
  // Changing a filter starts again from the newest entries.
  const filter = (updates: Record<string, string | null>) => url.set({ ...updates, cursor: null });
  const older = cursorFrom(query.data?.next);
  const newer = cursorFrom(query.data?.previous);

  const columns: Column<Ledger>[] = [
    { key: "date", header: "Date", cell: (r) => <span className="whitespace-nowrap">{date(r.posting_date)}</span> },
    { key: "item", header: "Item", cell: (r) => <span className="num font-medium">{r.item_code}{r.batch_number ? <span className="block text-xs font-normal text-muted-foreground">Batch {r.batch_number}</span> : null}</span> },
    { key: "wh", header: "Warehouse", cell: (r) => <span className="num">{r.warehouse_code}</span> },
    { key: "mv", header: "Movement", cell: (r) => <span className="whitespace-nowrap">{MOVEMENT_LABELS[r.movement_type] ?? r.movement_type.replace(/_/g, " ")}</span> },
    { key: "status", header: "Stock status", cell: (r) => <InvStatus kind="stock" status={r.stock_status} /> },
    { key: "qty", header: "Quantity", align: "right", cell: (r) => (
      <span className={`num font-medium ${r.quantity.startsWith("-") ? "text-status-rejected" : "text-status-approved"}`}>{signedQty(r.quantity)}</span>
    ) },
    { key: "cost", header: "Unit cost", align: "right", cell: (r) => <span className="num">{money(r.unit_cost)}</span> },
    { key: "value", header: "Value", align: "right", cell: (r) => <span className="num">{money(r.value)}</span> },
    { key: "bal", header: "Balance after", align: "right", cell: (r) => <span className="num text-muted-foreground">{qty(r.balance_quantity_after)}</span> },
    { key: "src", header: "Source", cell: (r) => <Source row={r} /> },
  ];

  return (
    <>
      <PageHeader title="Stock ledger" description="Every stock movement, newest first. Entries are permanent; corrections are new entries." />
      <Section
        actions={
          <FilterBar>
            <ItemPicker value={itemQuery.data ?? null} onChange={(i) => filter({ item: i?.id ?? null })} placeholder="Any item" className="sm:w-52" ariaLabel="Item" />
            <WarehouseSelect value={warehouse} onChange={(v) => filter({ warehouse: v })} allowAny className="sm:w-48" ariaLabel="Warehouse" />
            <Select value={movement || ANY} onValueChange={(v) => filter({ movement: v === ANY ? null : v })}>
              <SelectTrigger className="w-full sm:w-44" aria-label="Movement"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any movement</SelectItem>
                {Object.entries(MOVEMENT_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Label htmlFor="from" className="sr-only">From date</Label>
              <Input id="from" type="date" value={from} max={to || undefined} onChange={(e) => filter({ from: e.target.value || null })} className="h-9 min-w-0 flex-1 sm:w-38" />
              <span className="text-muted-foreground" aria-hidden>–</span>
              <Label htmlFor="to" className="sr-only">To date</Label>
              <Input id="to" type="date" value={to} min={from || undefined} onChange={(e) => filter({ to: e.target.value || null })} className="h-9 min-w-0 flex-1 sm:w-38" />
            </div>
            {(item || warehouse || movement || from || to || sourceId) && (
              <Button variant="ghost" size="sm" onClick={() => filter({ item: null, warehouse: null, movement: null, from: null, to: null, source_id: null })}>Clear</Button>
            )}
          </FilterBar>
        }
      >
        {sourceId && <p className="border-b px-5 py-2 text-sm text-muted-foreground">Showing the movements of one document.</p>}
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          caption="Stock ledger entries" empty={<EmptyState icon={BookOpen} title="No movements match" description="Posted receipts, issues, transfers, counts and adjustments appear here." />} />
        {query.data && query.data.results.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-2.5 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>Rows</span>
              <Select value={size} onValueChange={(v) => url.set({ size: v === "50" ? null : v, cursor: null })}>
                <SelectTrigger size="sm" className="w-20" aria-label="Rows per page"><SelectValue /></SelectTrigger>
                <SelectContent>{["10", "25", "50", "100"].map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" disabled={!newer && !cursor} onClick={() => url.set({ cursor: newer })} aria-label="Newer entries"><ChevronLeft aria-hidden /> Newer</Button>
              <Button variant="ghost" size="sm" disabled={!older} onClick={() => url.set({ cursor: older })} aria-label="Older entries">Older <ChevronRight aria-hidden /></Button>
            </div>
          </div>
        )}
      </Section>
    </>
  );
}
