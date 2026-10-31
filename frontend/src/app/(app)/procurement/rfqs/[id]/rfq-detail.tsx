"use client";

import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Plus, Trophy } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState, ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, DocStatus, Facts, Money, today } from "@/components/trade/common";
import { add, dec, fixed, lineTaxable, trim } from "@/components/trade/decimal";
import { useTradeAction } from "@/components/trade/layout";
import { LineEditor } from "@/components/trade/line-editor";
import { WarehouseSelect } from "@/components/trade/pickers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, useItemIndex, usePartnerIndex, useUoms } from "@/lib/api/trade";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

type RFQ = components["schemas"]["PurchaseRFQ"];
/** The comparison endpoint returns more than its OpenAPI schema declares (score only). */
type Ranking = { quotation_id: string; supplier: string; total: string; lead_time_days: number; supplier_rating: string | null; score: string; is_cheapest: boolean };
type QuoteLine = { rfq_line: string; rate: string; discount_pct: string };

function RecordQuotation({ rfq, open, onOpenChange }: { rfq: RFQ; open: boolean; onOpenChange: (o: boolean) => void }) {
  const suppliers = usePartnerIndex("supplier");
  const items = useItemIndex();
  const uoms = useUoms();
  const [form, setForm] = useState({ supplier: "", supplier_reference: "", received_on: today(), valid_until: today(30), lead_time_days: "7", payment_terms_days: "30" });
  const [lines, setLines] = useState<QuoteLine[]>(() => (rfq.lines ?? []).map((l) => ({ rfq_line: l.id, rate: "", discount_pct: "" })));
  const source = rfq.lines ?? [];
  const estimate = add(...(rfq.lines ?? []).map((l, i) => lineTaxable(l.quantity, lines[i]?.rate ?? "", lines[i]?.discount_pct ?? "") ?? BigInt(0)));
  const ready = form.supplier && lines.every((l) => dec(l.rate)) && form.lead_time_days;
  const save = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/rfqs/{id}/quotations/", {
      params: { path: { id: rfq.id } },
      body: {
        supplier: form.supplier, supplier_reference: form.supplier_reference, received_on: form.received_on, valid_until: form.valid_until,
        lead_time_days: Number(form.lead_time_days), payment_terms_days: Number(form.payment_terms_days || 0),
        lines: lines.map((l) => ({ rfq_line: l.rfq_line, rate: l.rate, discount_pct: l.discount_pct || "0" })),
      },
    })),
  (q) => { toast(`Quotation from ${q.supplier_name} recorded`); onOpenChange(false); });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
          <DialogHeader>
            <DialogTitle>Record a quotation</DialogTitle>
            <DialogDescription>Enter the supplier&apos;s rates for every item. Incomplete or expired quotations are left out of the comparison.</DialogDescription>
          </DialogHeader>
          <ActionError error={save.error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="q-supplier" label="Supplier">
              <Select value={form.supplier} onValueChange={(v) => setForm({ ...form, supplier: v })}>
                <SelectTrigger id="q-supplier" className="w-full"><SelectValue placeholder="Invited supplier" /></SelectTrigger>
                <SelectContent>{rfq.suppliers.map((s) => <SelectItem key={s} value={s}>{suppliers.name(s)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field id="q-ref" label="Supplier reference"><Input id="q-ref" value={form.supplier_reference} maxLength={60} onChange={(e) => setForm({ ...form, supplier_reference: e.target.value })} /></Field>
            <Field id="q-received" label="Received on"><Input id="q-received" type="date" value={form.received_on} onChange={(e) => setForm({ ...form, received_on: e.target.value })} required /></Field>
            <Field id="q-valid" label="Valid until"><Input id="q-valid" type="date" value={form.valid_until} onChange={(e) => setForm({ ...form, valid_until: e.target.value })} required /></Field>
            <Field id="q-lead" label="Lead time (days)"><Input id="q-lead" inputMode="numeric" className="num" value={form.lead_time_days} onChange={(e) => setForm({ ...form, lead_time_days: e.target.value.replace(/\D/g, "") })} required /></Field>
            <Field id="q-terms" label="Payment terms (days)"><Input id="q-terms" inputMode="numeric" className="num" value={form.payment_terms_days} onChange={(e) => setForm({ ...form, payment_terms_days: e.target.value.replace(/\D/g, "") })} /></Field>
          </div>
          <LineEditor idPrefix="q-line" lines={lines} onChange={setLines} readOnlyCount columns={[
            { key: "item", label: "Item", width: "minmax(8rem,1.5fr)", wide: true, render: (_l, _u, _id, i) => (
              <p className="num py-2 text-sm">{items.get(source[i]?.item)?.code ?? "Item"} <span className="text-muted-foreground">× {trim(source[i]?.quantity)} {uoms.code(source[i]?.uom)}</span></p>) },
            { key: "rate", label: "Rate", width: "8rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.rate} onChange={(e) => u({ rate: e.target.value })} /> },
            { key: "disc", label: "Discount %", width: "7rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.discount_pct} onChange={(e) => u({ discount_pct: e.target.value })} /> },
          ]} footer={<p className="text-sm text-muted-foreground">Estimate before GST: <span className="num font-medium text-foreground">₹{fixed(estimate, 2)}</span></p>} />
          <DialogFooter><Button type="submit" disabled={!ready || save.isPending}>Record quotation</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SelectQuotation({ rfq, row, onClose }: { rfq: RFQ; row: Ranking; onClose: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState({ warehouse: "", expected_date: today(row.lead_time_days), reason: "" });
  const select = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/rfqs/{id}/select/", { params: { path: { id: rfq.id } }, body: { quotation: row.quotation_id, ...form } })),
  (po) => { toast(`${po.number} drafted for ${po.supplier_name}`); onClose(); router.push(`/procurement/orders/${po.id}`); });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); select.mutate(undefined); }}>
          <DialogHeader>
            <DialogTitle>Select {row.supplier}</DialogTitle>
            <DialogDescription>Closes the RFQ and drafts a purchase order for the buyer who raised it. Someone other than the buyer approves the order.</DialogDescription>
          </DialogHeader>
          <ActionError error={select.error} hints={{ permission_denied: "You can't select quotations on this RFQ: you need the right to approve RFQs." }} />
          <Field id="sel-wh" label="Deliver to"><WarehouseSelect id="sel-wh" branchId={rfq.branch} value={form.warehouse} onChange={(v) => setForm({ ...form, warehouse: v })} /></Field>
          <Field id="sel-date" label="Expected by"><Input id="sel-date" type="date" value={form.expected_date} onChange={(e) => setForm({ ...form, expected_date: e.target.value })} required /></Field>
          <Field id="sel-reason" label="Reason for choosing" hint={row.is_cheapest ? "Optional for the cheapest quotation." : "Required: this is not the cheapest quotation."}>
            <Textarea id="sel-reason" rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
          <DialogFooter><Button type="submit" disabled={!form.warehouse || (!row.is_cheapest && !form.reason.trim()) || select.isPending}>Select and draft PO</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RfqDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const scopes = useCompanyScopes();
  const suppliers = usePartnerIndex("supplier");
  const items = useItemIndex();
  const uoms = useUoms();
  const [recording, setRecording] = useState(false);
  const [selecting, setSelecting] = useState<Ranking | null>(null);
  const query = useQuery({ queryKey: tradeKey("rfqs", id), queryFn: () => unwrap(api.GET("/api/v1/procurement/rfqs/{id}/", { params: { path: { id } } })) });
  const comparison = useQuery({
    queryKey: tradeKey("rfqs", id, "comparison"),
    queryFn: async () => (await unwrap(api.GET("/api/v1/procurement/rfqs/{id}/comparison/", { params: { path: { id } } }))) as unknown as Ranking[],
  });
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const rfq = query.data!;
  const open = rfq.status === "open";
  const lineColumns: Column<NonNullable<RFQ["lines"]>[number]>[] = [
    { key: "item", header: "Item", cell: (l) => <span><span className="num block">{items.get(l.item)?.code ?? "—"}</span><span className="block text-xs text-muted-foreground">{items.get(l.item)?.name}</span></span> },
    { key: "qty", header: "Quantity", align: "right", cell: (l) => <span className="num">{trim(l.quantity)} {uoms.code(l.uom)}</span> },
  ];
  const rankColumns: Column<Ranking & { id: string }>[] = [
    { key: "supplier", header: "Supplier", cell: (r) => <span className="flex flex-wrap items-center gap-2">{r.supplier}{r.is_cheapest && <StatusBadge tone="approved">Cheapest</StatusBadge>}</span> },
    { key: "total", header: "Total before GST", align: "right", cell: (r) => <Money value={r.total} /> },
    { key: "lead", header: "Lead time", align: "right", cell: (r) => <span className="num">{r.lead_time_days} d</span> },
    { key: "rating", header: "Rating", align: "right", cell: (r) => <span className="num">{r.supplier_rating ? trim(r.supplier_rating) : "Unrated"}</span> },
    { key: "score", header: "Score", align: "right", cell: (r) => <span className="num font-semibold">{trim(r.score)}</span> },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => open && can("procurement.rfq.approve")
      ? <Button size="sm" variant="outline" onClick={() => setSelecting(r)}>Select</Button> : null },
  ];
  return (
    <>
      <PageHeader crumbs={[{ label: "RFQs", href: "/procurement/rfqs" }, { label: rfq.number }]} title={`RFQ ${rfq.number}`}
        meta={<><DocStatus status={rfq.status} /><span className="text-muted-foreground">Quotes due {date(rfq.respond_by)}</span></>}
        actions={open && can("procurement.rfq.update") && <Button onClick={() => setRecording(true)}><Plus aria-hidden /> Record quotation</Button>} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <Section title="Comparison" description="Score = 60% price, 20% lead time, 20% supplier rating (unrated suppliers count as 50). Only complete, unexpired quotations are ranked.">
            <DataTable columns={rankColumns} rows={comparison.data?.map((r) => ({ ...r, id: r.quotation_id }))} isLoading={comparison.isLoading}
              error={comparison.error} onRetry={comparison.refetch} caption="Quotation comparison"
              empty={<EmptyState icon={Trophy} title="No comparable quotations yet" description="Record each supplier's quotation with a rate for every item." />} />
          </Section>
          <Section title="Items"><DataTable columns={lineColumns} rows={rfq.lines ?? []} caption="RFQ items" /></Section>
        </div>
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <Section title="Details">
            <Facts className="sm:grid-cols-[minmax(7rem,auto)_minmax(0,1fr)]" items={[
              ["Branch", scopes.name(rfq.branch)],
              ["Requisition", rfq.requisition ? <a className="underline underline-offset-2" href={`/procurement/requisitions/${rfq.requisition}`}>Open requisition</a> : "Direct"],
              ["Created", dateTime(rfq.created_at)],
              ["Notes", rfq.notes || "—"],
            ]} />
          </Section>
          <Section title="Invited suppliers">
            <ul className="grid gap-1 px-5 py-4 text-sm">
              {rfq.suppliers.length === 0 ? <EmptyState icon={ClipboardList} title="No suppliers" /> : rfq.suppliers.map((s) => <li key={s}>{suppliers.name(s)}</li>)}
            </ul>
          </Section>
        </div>
      </div>
      {recording && <RecordQuotation rfq={rfq} open onOpenChange={setRecording} />}
      {selecting && <SelectQuotation rfq={rfq} row={selecting} onClose={() => setSelecting(null)} />}
    </>
  );
}
