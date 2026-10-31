"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Boxes, ScanLine, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { ActionError, ANY, Facts, FilterBar, ItemPicker, WarehouseSelect } from "@/components/inventory/bits";
import { qty } from "@/components/inventory/decimal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import {
  ITEM_TYPES, todayIso, useAvailability, useCategories, useItem, useWarehouses,
  type AgeingRow, type ScanResult, type Stock,
} from "@/lib/api/inventory";
import { date, money } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type Drill = { item: string; itemCode: string; itemName: string; uom: string; warehouse: string; warehouseCode: string };

function AvailabilitySheet({ drill, onClose }: { drill: Drill | null; onClose: () => void }) {
  const { can } = useSession();
  const query = useAvailability(drill?.item, drill?.warehouse);
  const a = query.data;
  const u = drill?.uom;
  return (
    <Sheet open={!!drill} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle><span className="num">{drill?.itemCode}</span> in <span className="num">{drill?.warehouseCode}</span></SheetTitle>
          <SheetDescription>{drill?.itemName}. Only unrestricted stock that isn&apos;t reserved can be issued.</SheetDescription>
        </SheetHeader>
        <div className="grid gap-5 px-4 pb-6">
          {query.isLoading ? <RowsSkeleton rows={4} /> : query.error ? <ErrorState error={query.error} onRetry={query.refetch} /> : a && (
            <>
              <div className="grid grid-cols-2 gap-3" aria-label="Availability">
                <Figure label="Available to issue" value={qty(a.available, u)} strong />
                <Figure label="On hand" value={qty(a.on_hand, u)} />
              </div>
              <Facts items={[
                ["Unrestricted", <span key="u" className="num">{qty(a.unrestricted, u)}</span>],
                ["Reserved", <span key="r" className="num">{qty(a.reserved, u)}</span>],
                ["Quality hold", <span key="q" className="num">{qty(a.quality_hold, u)}</span>],
                ["Blocked", <span key="b" className="num">{qty(a.blocked, u)}</span>],
                ["In transit", <span key="t" className="num">{qty(a.in_transit, u)}</span>],
                ["Average cost", <span key="c" className="num">{money(a.avg_cost)}</span>],
                ["Value", <span key="v" className="num">{money(a.value)}</span>],
              ]} />
              {can("inventory.stock_ledger.read") && drill && (
                <Button variant="outline" asChild className="justify-self-start">
                  <Link href={`/inventory/ledger?item=${drill.item}&warehouse=${drill.warehouse}`}>View movements</Link>
                </Button>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? "rounded-md border border-foreground/20 bg-primary/15 px-3 py-2.5" : "rounded-md border px-3 py-2.5"}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num mt-0.5 text-lg font-semibold">{value}</p>
    </div>
  );
}

function ScanBox({ onItem }: { onItem: (itemId: string) => void }) {
  const wh = useWarehouses({ activeCompanyOnly: false });
  const [code, setCode] = useState("");
  const scan = useMutation({
    mutationFn: async (value: string): Promise<ScanResult> => {
      try {
        // Item codes and barcodes resolve through item lookup; serials, batches and bins through scan.
        const item = await unwrap(api.GET("/api/v1/masterdata/items/lookup/", { params: { query: { code: value } } }));
        return { kind: "item", item_id: item.id, item_code: item.code, uom_id: null };
      } catch (error) {
        if (!isApiError(error) || error.status !== 404) throw error;
        return (await unwrap(api.GET("/api/v1/inventory/scan/", { params: { query: { code: value } } }))) as unknown as ScanResult;
      }
    },
  });
  const r = scan.data;
  return (
    <Section className="mb-6">
      <form className="flex flex-wrap items-end gap-3 px-5 py-4" onSubmit={(e) => { e.preventDefault(); if (code.trim()) scan.mutate(code.trim()); }}>
        <div className="grid min-w-0 flex-1 basis-60 gap-1.5">
          <Label htmlFor="scan-code">Scan or type a code</Label>
          <div className="relative">
            <ScanLine className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input id="scan-code" value={code} onChange={(e) => setCode(e.target.value)} className="num pl-8" autoComplete="off"
              placeholder="Barcode, serial, batch, bin or item code" />
          </div>
        </div>
        <Button type="submit" variant="outline" disabled={scan.isPending || !code.trim()}><Search aria-hidden /> Look up</Button>
      </form>
      {(scan.error || r) && (
        <div className="border-t px-5 py-3.5" aria-live="polite">
          {scan.error ? (
            isApiError(scan.error) && scan.error.status === 404
              ? <p className="text-sm text-muted-foreground">Nothing matches <span className="num font-medium text-foreground">{scan.variables}</span>.</p>
              : <ActionError error={scan.error} />
          ) : r && (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <p data-testid="scan-result">
                {r.kind === "item" && <>Item <span className="num font-semibold">{r.item_code}</span></>}
                {r.kind === "serial" && <>Serial of <span className="num font-semibold">{r.item_code}</span>, {r.status.replace("_", " ")}{r.warehouse_id ? <> in <span className="num">{wh.label(r.warehouse_id)}</span></> : null}</>}
                {r.kind === "batch" && <>Batch of <span className="num font-semibold">{r.item_code}</span>{r.expires_on ? `, expires ${date(r.expires_on)}` : ", no expiry"}</>}
                {r.kind === "location" && <>Storage bin in <span className="num font-semibold">{wh.label(r.warehouse_id)}</span></>}
              </p>
              {"item_id" in r && <Button size="sm" variant="outline" onClick={() => onItem(r.item_id)}>Show its stock</Button>}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function OnHand({ onDrill }: { onDrill: (d: Drill) => void }) {
  const url = useUrlState();
  const wh = useWarehouses();
  const categories = useCategories();
  const warehouse = url.get("warehouse");
  const itemId = url.get("item");
  const type = url.get("type");
  const category = url.get("category");
  const search = url.get("q");
  const [draft, setDraft] = useState(search);
  const item = useItem(itemId || null);
  const query = useQuery({
    queryKey: ["inventory", "stock", warehouse, itemId, type, category, search, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/inventory/stock/", {
      params: { query: {
        warehouse: warehouse || undefined, item: itemId || undefined, item__category: category || undefined, search: search || undefined,
        item__item_type: (type || undefined) as never, page: url.page,
      } },
    })),
  });
  const columns: Column<Stock>[] = [
    { key: "item", header: "Item", cell: (s) => (
      <button type="button" className="text-left underline-offset-4 hover:underline focus-visible:underline"
        onClick={() => onDrill({ item: s.item, itemCode: s.item_code, itemName: s.item_name, uom: s.uom, warehouse: s.warehouse, warehouseCode: s.warehouse_code })}
        aria-label={`Availability of ${s.item_code} in ${s.warehouse_code}`}>
        <span className="num block font-medium">{s.item_code}</span>
        <span className="block max-w-[28ch] truncate text-xs text-muted-foreground">{s.item_name}</span>
      </button>
    ) },
    { key: "wh", header: "Warehouse", cell: (s) => <span className="num">{s.warehouse_code}</span> },
    { key: "qty", header: "On hand", align: "right", cell: (s) => <span className="num whitespace-nowrap">{qty(s.quantity)} <span className="text-muted-foreground">{s.uom}</span></span> },
    { key: "res", header: "Reserved", align: "right", cell: (s) => <span className="num text-muted-foreground">{qty(s.reserved_quantity)}</span> },
    { key: "cost", header: "Avg cost", align: "right", cell: (s) => <span className="num">{money(s.avg_cost)}</span> },
    { key: "value", header: "Value", align: "right", cell: (s) => <span className="num font-medium">{money(s.value)}</span> },
  ];
  return (
    <Section
      actions={
        <FilterBar>
          <form onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }} className="relative w-full sm:w-48">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Item code or name" className="h-9 pl-8" aria-label="Search stock" />
          </form>
          <WarehouseSelect value={warehouse} onChange={(v) => url.set({ warehouse: v })} allowAny className="sm:w-48" ariaLabel="Warehouse" />
          <ItemPicker value={item.data ?? null} onChange={(i) => url.set({ item: i?.id ?? null })} placeholder="Any item" className="sm:w-52" ariaLabel="Item" />
          <Select value={type || ANY} onValueChange={(v) => url.set({ type: v === ANY ? null : v })}>
            <SelectTrigger className="w-full sm:w-40" aria-label="Item type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any type</SelectItem>
              {Object.entries(ITEM_TYPES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={category || ANY} onValueChange={(v) => url.set({ category: v === ANY ? null : v })}>
            <SelectTrigger className="w-full sm:w-40" aria-label="Category"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any category</SelectItem>
              {categories.data?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {(warehouse || itemId || type || category || search) && (
            <Button variant="ghost" size="sm" onClick={() => { setDraft(""); url.set({ warehouse: null, item: null, type: null, category: null, q: null }); }}>Clear</Button>
          )}
        </FilterBar>
      }
    >
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading || wh.isLoading} error={query.error} onRetry={query.refetch}
        caption="Stock on hand by item and warehouse"
        empty={<EmptyState icon={Boxes} title="No stock matches" description="Stock appears here once receipts, adjustments or transfers are posted." />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
    </Section>
  );
}

function Ageing() {
  const url = useUrlState();
  const asOf = url.get("as_of") || todayIso();
  const warehouse = url.get("warehouse");
  const query = useQuery({
    queryKey: ["inventory", "ageing", asOf],
    queryFn: async () => (await unwrap(api.GET("/api/v1/inventory/ageing/", { params: { query: { as_of: asOf } } }))) as unknown as { as_of: string; rows: AgeingRow[] },
  });
  const rows = query.data?.rows.filter((r) => !warehouse || r.warehouse_id === warehouse);
  const buckets = query.data?.rows[0] ? Object.keys(query.data.rows[0].buckets) : [];
  const columns: Column<AgeingRow & { id: string }>[] = [
    { key: "item", header: "Item", cell: (r) => <span><span className="num block font-medium">{r.item_code}</span><span className="block max-w-[24ch] truncate text-xs text-muted-foreground">{r.item_name}</span></span> },
    { key: "wh", header: "Warehouse", cell: (r) => <span className="num">{r.warehouse_code}</span> },
    { key: "qty", header: "On hand", align: "right", cell: (r) => <span className="num">{qty(r.quantity)}</span> },
    ...buckets.map((b, i) => ({
      key: `b${i}`, header: b, align: "right" as const,
      cell: (r: AgeingRow) => {
        const v = r.buckets[b];
        const zero = !v || /^0(\.0+)?$/.test(v);
        return <span className={`num ${zero ? "text-muted-foreground/60" : i >= 3 ? "font-medium text-status-pending" : ""}`}>{zero ? "—" : qty(v)}</span>;
      },
    })),
    { key: "value", header: "Value", align: "right", cell: (r) => <span className="num">{money(r.value)}</span> },
  ];
  return (
    <Section
      description="On-hand quantity allocated to the most recent receipts (first in, first out)."
      actions={
        <FilterBar>
          <div className="flex items-center gap-2">
            <Label htmlFor="as-of" className="shrink-0 text-muted-foreground">As of</Label>
            <Input id="as-of" type="date" value={asOf} max={todayIso()} onChange={(e) => url.set({ as_of: e.target.value || null })} className="h-9 w-40" />
          </div>
          <WarehouseSelect value={warehouse} onChange={(v) => url.set({ warehouse: v })} allowAny className="sm:w-48" ariaLabel="Warehouse" />
        </FilterBar>
      }
    >
      <DataTable columns={columns} rows={rows?.map((r) => ({ ...r, id: `${r.item_id}-${r.warehouse_id}` }))} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
        caption="Stock ageing" empty={<EmptyState icon={Boxes} title="No stock to age" description="Ageing covers items with stock on hand in warehouses you can see." />} />
    </Section>
  );
}

export function StockView() {
  const url = useUrlState();
  const { can } = useSession();
  const tab = url.get("tab") || "on-hand";
  const [drill, setDrill] = useState<Drill | null>(null);
  return (
    <>
      <PageHeader title="Stock on hand" description="Quantities and value by item and warehouse. Select an item to see what is free to issue." />
      {can("masterdata.item.read") && <ScanBox onItem={(itemId) => url.set({ tab: null, item: itemId })} />}
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "on-hand" ? null : v })}>
        <TabsList className="mb-4">
          <TabsTrigger value="on-hand">On hand</TabsTrigger>
          <TabsTrigger value="ageing">Ageing</TabsTrigger>
        </TabsList>
        <TabsContent value="on-hand"><OnHand onDrill={setDrill} /></TabsContent>
        <TabsContent value="ageing"><Ageing /></TabsContent>
      </Tabs>
      <AvailabilitySheet drill={drill} onClose={() => setDrill(null)} />
    </>
  );
}
