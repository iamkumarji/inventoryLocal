"use client";

import { useQuery } from "@tanstack/react-query";
import { PackageCheck, Plus, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ActionError, DocStatus, today } from "@/components/trade/common";
import { add, cmp, dec, dec0, max, percentOf, toPlain, trim } from "@/components/trade/decimal";
import { FormSheet, StatusFilter, useTradeAction } from "@/components/trade/layout";
import { LineEditor } from "@/components/trade/line-editor";
import { WarehouseSelect } from "@/components/trade/pickers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, useItemIndex, usePartnerIndex, useUoms } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type GRN = components["schemas"]["PurchaseReceipt"];
type PRN = components["schemas"]["PurchaseReturn"];
type POLine = components["schemas"]["PurchasePOLine"];
type GrnLine = { po_line: string; quantity: string; batch_number: string; expires_on: string };
type RetLine = { receipt_line: string; quantity: string; from_status: string };

/** Most a line can still receive: ordered × (1 + tolerance%) − received. */
export function receivable(l: POLine) {
  const ordered = dec0(l.quantity);
  const limit = add(ordered, percentOf(ordered, dec0(l.over_receipt_pct)));
  return { open: max(ordered - dec0(l.received_quantity), BigInt(0)), limit: max(limit - dec0(l.received_quantity), BigInt(0)) };
}

function NewReceipt({ initialPo, onClose }: { initialPo: string; onClose: () => void }) {
  const router = useRouter();
  const uoms = useUoms();
  const items = useItemIndex();
  const [poId, setPoId] = useState(initialPo);
  const [form, setForm] = useState({ warehouse: "", receipt_date: today(), supplier_delivery_note: "", vehicle_number: "" });
  const [lines, setLines] = useState<GrnLine[]>([]);
  const orders = useQuery({
    queryKey: tradeKey("orders", "receivable"),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/orders/", { params: { query: { status: "approved", page_size: 100 } } })),
  });
  const po = useQuery({
    queryKey: tradeKey("orders", poId),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/orders/{id}/", { params: { path: { id: poId } } })),
    enabled: !!poId,
  });
  const [seeded, setSeeded] = useState<string | null>(null);
  if (po.data && seeded !== po.data.id) {
    setSeeded(po.data.id);
    setForm((f) => ({ ...f, warehouse: po.data!.lines[0]?.warehouse ?? "" }));
    setLines(po.data.lines.map((l) => ({ po_line: l.id, quantity: toPlain(receivable(l).open), batch_number: "", expires_on: "" })));
  }
  const poLines = po.data?.lines ?? [];
  const chosen = lines.filter((l) => dec(l.quantity) && dec0(l.quantity) > BigInt(0));
  const create = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/receipts/", {
      body: {
        purchase_order: poId, ...form,
        lines: chosen.map((l) => ({ po_line: l.po_line, quantity: l.quantity, batch_number: l.batch_number, expires_on: l.expires_on || null })),
      },
    })),
  (g) => { toast("Goods receipt saved as draft. Post it to bring the stock in."); onClose(); router.push(`/procurement/receipts/${g.id}`); });
  const openOrders = (orders.data?.results ?? []).filter((o) => o.receipt_status !== "received" || o.id === poId);

  return (
    <FormSheet open onOpenChange={(o) => !o && onClose()} title="New goods receipt" description="Quantities are in the order's unit. The server converts them to stock units and refuses receipts above the order plus its tolerance.">
      <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
        <ActionError error={create.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="grn-po" label="Purchase order" className="sm:col-span-2">
            <Select value={poId} onValueChange={setPoId}>
              <SelectTrigger id="grn-po" className="w-full"><SelectValue placeholder="Choose an approved order" /></SelectTrigger>
              <SelectContent>{openOrders.map((o) => <SelectItem key={o.id} value={o.id}>{o.number} · {o.supplier_name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="grn-wh" label="Receiving warehouse"><WarehouseSelect id="grn-wh" branchId={po.data?.branch} value={form.warehouse} onChange={(v) => setForm({ ...form, warehouse: v })} /></Field>
          <Field id="grn-date" label="Receipt date"><Input id="grn-date" type="date" value={form.receipt_date} onChange={(e) => setForm({ ...form, receipt_date: e.target.value })} required /></Field>
          <Field id="grn-dn" label="Supplier delivery note"><Input id="grn-dn" maxLength={60} value={form.supplier_delivery_note} onChange={(e) => setForm({ ...form, supplier_delivery_note: e.target.value })} /></Field>
          <Field id="grn-vehicle" label="Vehicle number"><Input id="grn-vehicle" maxLength={20} className="uppercase" value={form.vehicle_number} onChange={(e) => setForm({ ...form, vehicle_number: e.target.value.toUpperCase() })} /></Field>
        </div>
        {po.data && (
          <div className="grid gap-2">
            <p className="type-section">Lines received</p>
            <LineEditor idPrefix="grn-line" lines={lines} onChange={setLines} readOnlyCount columns={[
              { key: "item", label: "Item", width: "minmax(10rem,2fr)", wide: true, render: (_l, _u, _id, i) => {
                const pl = poLines[i];
                const r = receivable(pl);
                return (
                  <div className="py-1 text-sm">
                    <p className="num font-medium">{pl.item_code}{items.get(pl.item)?.inspection_required && <span className="ml-2 text-xs font-normal text-status-pending">inspection on receipt</span>}</p>
                    <p className="num text-xs text-muted-foreground">Ordered {trim(pl.quantity)} {uoms.code(pl.uom)} · received {trim(pl.received_quantity)} · can take {toPlain(r.limit)}{dec0(pl.over_receipt_pct) > BigInt(0) ? ` (incl. ${trim(pl.over_receipt_pct)}% tolerance)` : " (no tolerance)"}</p>
                  </div>
                );
              } },
              { key: "qty", label: "Receive", width: "7rem", render: (l, u, id, i) => {
                const over = dec(l.quantity) !== null && cmp(dec0(l.quantity), receivable(poLines[i]).limit) > 0;
                return (
                  <div className="grid gap-1">
                    <div className="flex items-center gap-1">
                      <Input id={id} inputMode="decimal" className="num" aria-invalid={over} value={l.quantity} onChange={(e) => u({ quantity: e.target.value })} />
                      <span className="text-xs text-muted-foreground">{uoms.code(poLines[i].uom)}</span>
                    </div>
                    {over && <p className="text-xs text-status-rejected">Over the order and tolerance; posting will be refused.</p>}
                  </div>
                );
              } },
              { key: "batch", label: "Batch", width: "7rem", render: (l, u, id) => <Input id={id} value={l.batch_number} maxLength={60} onChange={(e) => u({ batch_number: e.target.value })} /> },
              { key: "exp", label: "Expires", width: "9rem", render: (l, u, id) => <Input id={id} type="date" value={l.expires_on} onChange={(e) => u({ expires_on: e.target.value })} /> },
            ]} />
          </div>
        )}
        <Button type="submit" disabled={!poId || !form.warehouse || chosen.length === 0 || create.isPending}>Save draft receipt</Button>
      </form>
    </FormSheet>
  );
}

function NewReturn({ initialGrn, onClose }: { initialGrn: string; onClose: () => void }) {
  const router = useRouter();
  const [grnId, setGrnId] = useState(initialGrn);
  const [form, setForm] = useState({ return_date: today(), reason: "" });
  const [lines, setLines] = useState<RetLine[]>([]);
  const posted = useQuery({
    queryKey: tradeKey("receipts", "posted"),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/receipts/", { params: { query: { status: "posted", page_size: 100 } } })),
  });
  const grn = posted.data?.results.find((g) => g.id === grnId);
  const [seeded, setSeeded] = useState<string | null>(null);
  if (grn && seeded !== grn.id) {
    setSeeded(grn.id);
    setLines(grn.lines.map((l) => ({ receipt_line: l.id, quantity: "", from_status: l.inspection ? "quality_hold" : "unrestricted" })));
  }
  const chosen = lines.filter((l) => dec(l.quantity) && dec0(l.quantity) > BigInt(0));
  const create = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/returns/", { body: { receipt: grnId, ...form, lines: chosen } })),
  (r) => { toast("Return saved as draft. Post it to send the stock back."); onClose(); router.push(`/procurement/receipts/returns/${r.id}`); });
  return (
    <FormSheet open onOpenChange={(o) => !o && onClose()} title="New purchase return" description="Return received goods to the supplier. Quantities are in the order's unit.">
      <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
        <ActionError error={create.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="ret-grn" label="Goods receipt" className="sm:col-span-2">
            <Select value={grnId} onValueChange={setGrnId}>
              <SelectTrigger id="ret-grn" className="w-full"><SelectValue placeholder="Choose a posted receipt" /></SelectTrigger>
              <SelectContent>{posted.data?.results.map((g) => <SelectItem key={g.id} value={g.id}>{g.number} · {g.supplier_name} · {date(g.receipt_date)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="ret-date" label="Return date"><Input id="ret-date" type="date" value={form.return_date} onChange={(e) => setForm({ ...form, return_date: e.target.value })} required /></Field>
          <Field id="ret-reason" label="Reason"><Input id="ret-reason" maxLength={300} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required /></Field>
        </div>
        {grn && (
          <LineEditor idPrefix="ret-line" lines={lines} onChange={setLines} readOnlyCount columns={[
            { key: "item", label: "Item", width: "minmax(10rem,2fr)", wide: true, render: (_l, _u, _id, i) => (
              <p className="num py-2 text-sm">{grn.lines[i].item_code} <span className="text-muted-foreground">received {trim(grn.lines[i].quantity)}</span></p>) },
            { key: "qty", label: "Return", width: "7rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.quantity} onChange={(e) => u({ quantity: e.target.value })} /> },
            { key: "from", label: "From stock", width: "10rem", render: (l, u, id) => (
              <Select value={l.from_status} onValueChange={(v) => u({ from_status: v })}>
                <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="unrestricted">Unrestricted</SelectItem><SelectItem value="quality_hold">Quality hold</SelectItem><SelectItem value="blocked">Blocked</SelectItem></SelectContent>
              </Select>) },
          ]} />
        )}
        <Button type="submit" disabled={!grnId || !form.reason.trim() || chosen.length === 0 || create.isPending}>Save draft return</Button>
      </form>
    </FormSheet>
  );
}

export function ReceiptsView() {
  const { can } = useSession();
  const url = useUrlState();
  const tab = url.get("tab") || "receipts";
  const status = url.get("status");
  const scopes = useCompanyScopes();
  const suppliers = usePartnerIndex("supplier");
  const receipts = useQuery({
    queryKey: tradeKey("receipts", status, url.page),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/receipts/", { params: { query: { status: status || undefined, page: url.page } } })),
    enabled: tab === "receipts",
  });
  const returns = useQuery({
    queryKey: tradeKey("purchase-returns", status, url.page),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/returns/", { params: { query: { status: status || undefined, page: url.page } } })),
    enabled: tab === "returns",
  });
  const receiptNumbers = useQuery({
    queryKey: tradeKey("receipts", "posted"),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/receipts/", { params: { query: { status: "posted", page_size: 100 } } })),
    enabled: tab === "returns",
  });
  const grnNumber = useMemo(() => new Map((receiptNumbers.data?.results ?? []).map((g) => [g.id, g.number])), [receiptNumbers.data]);
  const grnColumns: Column<GRN>[] = [
    { key: "number", header: "Receipt", cell: (g) => <span><span className="num block">{g.number || "Draft"}</span><span className="block text-xs font-normal text-muted-foreground">{g.supplier_name}</span></span> },
    { key: "date", header: "Date", cell: (g) => date(g.receipt_date) },
    { key: "wh", header: "Warehouse", cell: (g) => scopes.name(g.warehouse) },
    { key: "lines", header: "Lines", align: "right", cell: (g) => <span className="num">{g.lines.length}</span> },
    { key: "qc", header: "Quality", cell: (g) => (g.lines.some((l) => l.inspection) ? <DocStatus status="pending" label="Quality hold" /> : <span className="text-muted-foreground">—</span>) },
    { key: "status", header: "Status", cell: (g) => <DocStatus status={g.status} /> },
  ];
  const retColumns: Column<PRN>[] = [
    { key: "number", header: "Return", cell: (r) => <span><span className="num block">{r.number || "Draft"}</span><span className="block text-xs font-normal text-muted-foreground">{suppliers.name(r.supplier)}</span></span> },
    { key: "grn", header: "Against receipt", cell: (r) => <span className="num">{grnNumber.get(r.receipt) ?? "—"}</span> },
    { key: "date", header: "Date", cell: (r) => date(r.return_date) },
    { key: "reason", header: "Reason", cell: (r) => <span className="block max-w-[30ch] truncate">{r.reason}</span> },
    { key: "status", header: "Status", cell: (r) => <DocStatus status={r.status} /> },
  ];
  const active = tab === "receipts" ? receipts : returns;
  return (
    <>
      <PageHeader title="Goods receipts" description="Receive against approved purchase orders. Items needing inspection go to quality hold until released."
        actions={tab === "receipts"
          ? can("procurement.goods_receipt.create") && <Button onClick={() => url.set({ new: 1 })}><Plus aria-hidden /> New receipt</Button>
          : can("procurement.purchase_return.create") && <Button onClick={() => url.set({ newReturn: 1 })}><Undo2 aria-hidden /> New return</Button>} />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "receipts" ? null : v, status: null })} className="mb-4">
        <TabsList>
          <TabsTrigger value="receipts">Receipts</TabsTrigger>
          <TabsTrigger value="returns">Purchase returns</TabsTrigger>
        </TabsList>
      </Tabs>
      <Section actions={<StatusFilter value={status} options={[["", "Any status"], ["draft", "Draft"], ["posted", "Posted"]]} onChange={(v) => url.set({ status: v })} />}>
        {tab === "receipts" ? (
          <DataTable columns={grnColumns} rows={receipts.data?.results} isLoading={receipts.isLoading} error={receipts.error} onRetry={receipts.refetch}
            rowHref={(g) => `/procurement/receipts/${g.id}`} caption="Goods receipts"
            empty={<EmptyState icon={PackageCheck} title="No goods receipts" description="Receive goods from an approved purchase order." />} />
        ) : (
          <DataTable columns={retColumns} rows={returns.data?.results} isLoading={returns.isLoading} error={returns.error} onRetry={returns.refetch}
            rowHref={(r) => `/procurement/receipts/returns/${r.id}`} caption="Purchase returns"
            empty={<EmptyState icon={Undo2} title="No purchase returns" />} />
        )}
        {active.data && <PageNav page={url.page} count={active.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
      {url.get("new") === "1" && <NewReceipt initialPo={url.get("po")} onClose={() => url.set({ new: null, po: null })} />}
      {url.get("newReturn") === "1" && <NewReturn initialGrn={url.get("grn")} onClose={() => url.set({ newReturn: null, grn: null })} />}
    </>
  );
}
