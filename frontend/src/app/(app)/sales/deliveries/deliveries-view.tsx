"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageCheck, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ActionError, DocStatus, today } from "@/components/trade/common";
import { cmp, dec, dec0, max, toPlain, trim } from "@/components/trade/decimal";
import { FormSheet, StatusFilter, useTradeAction } from "@/components/trade/layout";
import { LineEditor } from "@/components/trade/line-editor";
import { WarehouseSelect } from "@/components/trade/pickers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, useItemIndex, usePartnerIndex } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type DN = components["schemas"]["SalesDelivery"];
type SOLine = components["schemas"]["SalesOrderLine"];
type Line = { so_line: string; quantity: string; batch_number: string };
type Fefo = { batch_id: string; batch_number: string; expires_on: string | null; quantity: string };

const remaining = (l: SOLine) => max(dec0(l.stock_quantity) - dec0(l.delivered_quantity), BigInt(0));

function NewDelivery({ initialSo, onClose }: { initialSo: string; onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const items = useItemIndex();
  const [soId, setSoId] = useState(initialSo);
  const [form, setForm] = useState({ warehouse: "", delivery_date: today() });
  const [lines, setLines] = useState<Line[]>([]);
  const orders = useQuery({
    queryKey: tradeKey("sales-orders", "approved"),
    queryFn: () => unwrap(api.GET("/api/v1/sales/orders/", { params: { query: { status: "approved", page_size: 100 } } })),
  });
  const so = useQuery({
    queryKey: tradeKey("sales-orders", soId),
    queryFn: () => unwrap(api.GET("/api/v1/sales/orders/{id}/", { params: { path: { id: soId } } })),
    enabled: !!soId,
  });
  const warehouses = useMemo(() => [...new Set((so.data?.lines ?? []).filter((l) => remaining(l) > BigInt(0)).map((l) => l.warehouse))], [so.data]);
  const soLines = (so.data?.lines ?? []).filter((l) => l.warehouse === form.warehouse && remaining(l) > BigInt(0));
  const seedKey = `${so.data?.id}:${form.warehouse}`;
  const [seeded, setSeeded] = useState("");
  if (so.data && seeded !== seedKey) {
    setSeeded(seedKey);
    if (!form.warehouse && warehouses[0]) setForm((f) => ({ ...f, warehouse: warehouses[0] }));
    setLines(soLines.map((l) => ({ so_line: l.id, quantity: toPlain(remaining(l)), batch_number: "" })));
  }
  const chosen = lines.filter((l) => dec(l.quantity) && dec0(l.quantity) > BigInt(0));
  const suggest = async (soLine: SOLine, index: number) => {
    const rows = (await queryClient.fetchQuery({
      queryKey: tradeKey("fefo", soId, soLine.id),
      queryFn: () => unwrap(api.GET("/api/v1/sales/orders/{id}/fefo/", { params: { path: { id: soId }, query: { line: soLine.id } } })),
    })) as unknown as Fefo[];
    if (rows.length === 0) { toast("No batches with free stock in this warehouse"); return; }
    setLines((ls) => ls.map((l, i) => (i === index ? { ...l, batch_number: rows[0].batch_number } : l)));
    toast(`Earliest expiry: batch ${rows[0].batch_number}${rows[0].expires_on ? `, expires ${date(rows[0].expires_on)}` : ""}`);
  };
  const create = useTradeAction(() =>
    unwrap(api.POST("/api/v1/sales/deliveries/", { body: { sales_order: soId, warehouse: form.warehouse, delivery_date: form.delivery_date, lines: chosen } })),
  (d) => { toast("Delivery saved as draft. Post it to issue the stock."); onClose(); router.push(`/sales/deliveries/${d.id}`); });
  const openOrders = (orders.data?.results ?? []).filter((o) => o.lines.some((l) => remaining(l) > BigInt(0)) || o.id === soId);

  return (
    <FormSheet open onOpenChange={(o) => !o && onClose()} title="New delivery" description="Deliver from one warehouse at a time. Quantities are in stock units; reserved stock is used first.">
      <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
        <ActionError error={create.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="dn-so" label="Sales order" className="sm:col-span-2">
            <Select value={soId} onValueChange={(v) => { setSoId(v); setForm({ ...form, warehouse: "" }); }}>
              <SelectTrigger id="dn-so" className="w-full"><SelectValue placeholder="Choose an approved order" /></SelectTrigger>
              <SelectContent>{openOrders.map((o) => <SelectItem key={o.id} value={o.id}>{o.number} · {o.customer_name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="dn-wh" label="Ship from"><WarehouseSelect id="dn-wh" allowedIds={warehouses} value={form.warehouse} onChange={(v) => setForm({ ...form, warehouse: v })} /></Field>
          <Field id="dn-date" label="Delivery date"><Input id="dn-date" type="date" value={form.delivery_date} onChange={(e) => setForm({ ...form, delivery_date: e.target.value })} required /></Field>
        </div>
        {so.data && form.warehouse && (
          <LineEditor idPrefix="dn-line" lines={lines} onChange={setLines} readOnlyCount columns={[
            { key: "item", label: "Item", width: "minmax(10rem,2fr)", wide: true, render: (_l, _u, _id, i) => {
              const sl = soLines[i];
              if (!sl) return null;
              const unit = items.get(sl.item)?.stock_uom_code ?? "";
              return (
                <div className="py-1 text-sm">
                  <p className="num font-medium">{sl.item_code}</p>
                  <p className="num text-xs text-muted-foreground">Ordered {trim(sl.stock_quantity)} {unit} · delivered {trim(sl.delivered_quantity)} · reserved {trim(sl.reserved_quantity)} · open {toPlain(remaining(sl))}</p>
                </div>
              );
            } },
            { key: "qty", label: "Deliver", width: "7rem", render: (l, u, id, i) => {
              const sl = soLines[i];
              const over = sl && dec(l.quantity) !== null && cmp(dec0(l.quantity), remaining(sl)) > 0;
              return (
                <div className="grid gap-1">
                  <Input id={id} inputMode="decimal" className="num" aria-invalid={over} value={l.quantity} onChange={(e) => u({ quantity: e.target.value })} />
                  {over && <p className="text-xs text-status-rejected">More than ordered.</p>}
                </div>
              );
            } },
            { key: "batch", label: "Batch", width: "11rem", render: (l, u, id, i) => {
              const sl = soLines[i];
              const tracked = sl && items.get(sl.item)?.tracking === "batch";
              return (
                <div className="flex gap-1">
                  <Input id={id} value={l.batch_number} placeholder={tracked ? "Required" : "—"} onChange={(e) => u({ batch_number: e.target.value })} />
                  {tracked && <Button type="button" size="sm" variant="outline" onClick={() => suggest(sl, i)}>FEFO</Button>}
                </div>
              );
            } },
          ]} />
        )}
        <Button type="submit" disabled={!soId || !form.warehouse || chosen.length === 0 || create.isPending}>Save draft delivery</Button>
      </form>
    </FormSheet>
  );
}

export function DeliveriesView() {
  const { can } = useSession();
  const url = useUrlState();
  const status = url.get("status");
  const scopes = useCompanyScopes();
  const customers = usePartnerIndex("customer");
  const query = useQuery({
    queryKey: tradeKey("deliveries", status, url.page),
    queryFn: () => unwrap(api.GET("/api/v1/sales/deliveries/", { params: { query: { status: status || undefined, page: url.page } } })),
  });
  const columns: Column<DN>[] = [
    { key: "number", header: "Delivery", cell: (d) => <span><span className="num block">{d.number || "Draft"}</span><span className="block text-xs font-normal text-muted-foreground">{customers.name(d.customer)}</span></span> },
    { key: "date", header: "Date", cell: (d) => date(d.delivery_date) },
    { key: "wh", header: "Ship from", cell: (d) => scopes.name(d.warehouse) },
    { key: "lines", header: "Lines", align: "right", cell: (d) => <span className="num">{d.lines.length}</span> },
    { key: "status", header: "Status", cell: (d) => <DocStatus status={d.status} /> },
  ];
  return (
    <>
      <PageHeader title="Deliveries" description="Issue stock against approved orders. Posting a delivery books cost of goods sold on the server."
        actions={can("sales.delivery.create") && <Button onClick={() => url.set({ new: 1 })}><Plus aria-hidden /> New delivery</Button>} />
      <Section actions={<StatusFilter value={status} options={[["", "Any status"], ["draft", "Draft"], ["posted", "Posted"]]} onChange={(v) => url.set({ status: v })} />}>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(d) => `/sales/deliveries/${d.id}`} caption="Deliveries"
          empty={<EmptyState icon={PackageCheck} title="No deliveries" description="Create one from an approved sales order." />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
      {url.get("new") === "1" && <NewDelivery initialSo={url.get("so")} onClose={() => url.set({ new: null, so: null })} />}
    </>
  );
}
