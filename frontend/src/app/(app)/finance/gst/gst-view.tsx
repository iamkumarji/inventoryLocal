"use client";

import { useQuery } from "@tanstack/react-query";
import { subMonths } from "date-fns";
import { FileSpreadsheet } from "lucide-react";
import type { ReactNode } from "react";

import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Amount } from "@/components/finance/amount";
import { DateRange, FilterBar } from "@/components/finance/controls";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { type Gstr1, type Gstr3b, formatDecimal, isoDate, monthStart, sumDecimals } from "@/lib/api/finance";
import { date } from "@/lib/format";
import { useUrlState } from "@/lib/use-url-state";

function lastMonth() {
  const now = new Date();
  return { from: monthStart(subMonths(now, 1)), to: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)) };
}

const TAX_COLS = [
  { key: "taxable", header: "Taxable", align: "right" as const },
  { key: "cgst", header: "CGST", align: "right" as const },
  { key: "sgst", header: "SGST", align: "right" as const },
  { key: "igst", header: "IGST", align: "right" as const },
];

function TaxCells({ r }: { r: { taxable: string; cgst: string; sgst: string; igst: string } }) {
  return <>{(["taxable", "cgst", "sgst", "igst"] as const).map((k) => <Cell key={k} align="right"><Amount value={r[k]} currency={false} muteZero /></Cell>)}</>;
}
function TaxTotals<T extends { taxable: string; cgst: string; sgst: string; igst: string }>({ rows }: { rows: T[] }) {
  return <>{(["taxable", "cgst", "sgst", "igst"] as const).map((k) => <Cell key={k} align="right" className="font-semibold"><Amount value={sumDecimals(rows.map((r) => r[k]))} currency={false} /></Cell>)}</>;
}

function Part({ title, description, count, children }: { title: string; description?: string; count: number; children: ReactNode }) {
  return (
    <Section title={<span>{title} <span className="num ml-1 text-xs font-normal text-muted-foreground">{count}</span></span>} description={description}>
      {count === 0 ? <p className="px-5 py-4 text-sm text-muted-foreground">Nothing in this period.</p> : children}
    </Section>
  );
}

function Gstr1View({ from, to }: { from: string; to: string }) {
  const q = useQuery({
    queryKey: ["finance", "gstr1", from, to],
    queryFn: async () => (await unwrap(api.GET("/api/v1/finance/gst/gstr1/", { params: { query: { date_from: from, date_to: to } } }))) as unknown as Gstr1,
  });
  if (q.error) return <Section><ErrorState error={q.error} onRetry={q.refetch} /></Section>;
  if (!q.data) return <Section><RowsSkeleton /></Section>;
  const g = q.data;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
      <Part title="B2B invoices" description="Supplies to registered customers (with GSTIN)." count={g.b2b.length}>
        <LedgerTable caption="B2B invoices" columns={[{ key: "gstin", header: "GSTIN" }, { key: "customer", header: "Customer" }, { key: "no", header: "Invoice" },
          { key: "date", header: "Date" }, { key: "pos", header: "Place of supply" }, ...TAX_COLS, { key: "total", header: "Invoice value", align: "right" }]}
          footer={<Row className="hover:bg-transparent"><Cell colSpan={5} className="font-semibold">Total</Cell><TaxTotals rows={g.b2b} />
            <Cell align="right" className="font-semibold"><Amount value={sumDecimals(g.b2b.map((r) => r.total))} currency={false} /></Cell></Row>}>
          {g.b2b.map((r) => (
            <Row key={r.number}><Cell>{r.gstin}</Cell><Cell className="min-w-40 font-sans">{r.customer}</Cell><Cell>{r.number}</Cell>
              <Cell className="whitespace-nowrap">{date(r.date)}</Cell><Cell>{r.place_of_supply}</Cell><TaxCells r={r} />
              <Cell align="right"><Amount value={r.total} currency={false} /></Cell></Row>
          ))}
        </LedgerTable>
      </Part>
      <Part title="B2C supplies" description="Unregistered customers, summarised by place of supply." count={g.b2c.length}>
        <LedgerTable caption="B2C supplies" columns={[{ key: "pos", header: "Place of supply" }, ...TAX_COLS]}
          footer={<Row className="hover:bg-transparent"><Cell className="font-semibold">Total</Cell><TaxTotals rows={g.b2c} /></Row>}>
          {g.b2c.map((r) => <Row key={r.place_of_supply}><Cell>{r.place_of_supply}</Cell><TaxCells r={r} /></Row>)}
        </LedgerTable>
      </Part>
      <Part title="HSN summary" count={g.hsn_summary.length}>
        <LedgerTable caption="HSN summary" columns={[{ key: "hsn", header: "HSN" }, { key: "rate", header: "GST %", align: "right" }, { key: "qty", header: "Quantity", align: "right" }, ...TAX_COLS]}
          footer={<Row className="hover:bg-transparent"><Cell colSpan={3} className="font-semibold">Total</Cell><TaxTotals rows={g.hsn_summary} /></Row>}>
          {g.hsn_summary.map((r, i) => (
            <Row key={`${r.hsn_code}-${r.gst_rate}-${i}`}><Cell>{r.hsn_code ?? "—"}</Cell><Cell align="right">{formatDecimal(r.gst_rate)}</Cell>
              <Cell align="right">{formatDecimal(r.quantity, { dp: 3 })}</Cell><TaxCells r={r} /></Row>
          ))}
        </LedgerTable>
      </Part>
      <Part title="Credit notes" description="Posted sales returns in the period." count={g.credit_notes.length}>
        <LedgerTable caption="Credit notes" columns={[{ key: "no", header: "Credit note" }, { key: "date", header: "Date" }, { key: "inv", header: "Against invoice" }, { key: "total", header: "Value", align: "right" }]}
          footer={<Row className="hover:bg-transparent"><Cell colSpan={3} className="font-semibold">Total</Cell><Cell align="right" className="font-semibold"><Amount value={sumDecimals(g.credit_notes.map((c) => c.total))} currency={false} /></Cell></Row>}>
          {g.credit_notes.map((c) => <Row key={c.number}><Cell>{c.number}</Cell><Cell className="whitespace-nowrap">{date(c.date)}</Cell><Cell>{c.invoice}</Cell><Cell align="right"><Amount value={c.total} currency={false} /></Cell></Row>)}
        </LedgerTable>
      </Part>
    </div>
  );
}

function Gstr3bView({ from, to }: { from: string; to: string }) {
  const q = useQuery({
    queryKey: ["finance", "gstr3b", from, to],
    queryFn: async () => (await unwrap(api.GET("/api/v1/finance/gst/gstr3b/", { params: { query: { date_from: from, date_to: to } } }))) as unknown as Gstr3b,
  });
  if (q.error) return <Section><ErrorState error={q.error} onRetry={q.refetch} /></Section>;
  if (!q.data) return <Section><RowsSkeleton /></Section>;
  const g = q.data;
  const rows: { label: string; split: Gstr3b["output_tax"]; strong?: boolean }[] = [
    { label: "Output tax on outward supplies", split: g.output_tax },
    { label: "Less: input tax credit (posted supplier invoices)", split: g.input_tax_credit },
    { label: "Net tax payable", split: g.net_payable, strong: true },
    { label: "Credit carried forward", split: g.carry_forward_credit },
  ];
  return (
    <Section title="GSTR-3B summary" description="Each tax head is netted separately; a negative balance carries forward as credit instead of being paid.">
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <p className="text-sm">Outward taxable value <span className="ml-2 font-semibold"><Amount value={g.outward_taxable} /></span></p>
        <p className="text-sm">Credit notes issued <span className="ml-2 font-semibold"><Amount value={g.credit_notes_total} /></span></p>
      </div>
      <LedgerTable caption="GSTR-3B tax summary" columns={[{ key: "line", header: "" }, { key: "cgst", header: "CGST", align: "right" }, { key: "sgst", header: "SGST", align: "right" }, { key: "igst", header: "IGST", align: "right" }, { key: "total", header: "Total", align: "right" }]}>
        {rows.map((r) => (
          <Row key={r.label} className={r.strong ? "bg-muted/40 font-semibold hover:bg-muted/40" : undefined}>
            <Cell className="min-w-56 font-sans">{r.label}</Cell>
            {(["cgst", "sgst", "igst"] as const).map((k) => <Cell key={k} align="right"><Amount value={r.split[k]} currency={false} muteZero /></Cell>)}
            <Cell align="right"><Amount value={sumDecimals([r.split.cgst, r.split.sgst, r.split.igst])} /></Cell>
          </Row>
        ))}
      </LedgerTable>
    </Section>
  );
}

export function GstView() {
  const url = useUrlState();
  const fallback = lastMonth();
  const view = url.get("view") || "gstr1";
  const from = url.get("from") || fallback.from;
  const to = url.get("to") || fallback.to;
  return (
    <>
      <PageHeader title="GST returns" description="Return data from posted invoices for the period. Filing itself happens through your GST suvidha provider." />
      <Tabs value={view} onValueChange={(v) => url.set({ view: v === "gstr1" ? null : v })} className="mb-4">
        <TabsList>
          <TabsTrigger value="gstr1">GSTR-1</TabsTrigger>
          <TabsTrigger value="gstr3b">GSTR-3B</TabsTrigger>
        </TabsList>
      </Tabs>
      <FilterBar><DateRange from={from} to={to} onChange={(r) => url.set({ from: r.from, to: r.to })} /></FilterBar>
      {view === "gstr1" ? <Gstr1View from={from} to={to} /> : <Gstr3bView from={from} to={to} />}
      <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><FileSpreadsheet className="size-3.5" aria-hidden /> CSV exports of B2B and HSN data are under Report exports.</p>
    </>
  );
}
