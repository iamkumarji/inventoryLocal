"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Receipt } from "lucide-react";
import Link from "next/link";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { Amount } from "@/components/finance/amount";
import { AsOf, DocStatus, FilterBar, MatchStatus } from "@/components/finance/controls";
import { AgeingTable, OpenItemsTable } from "@/components/finance/subledger";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { type SupplierInvoice, today } from "@/lib/api/finance";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const columns: Column<SupplierInvoice>[] = [
  { key: "ref", header: "Supplier's invoice", cell: (i) => <span><span className="block">{i.supplier_invoice_number}</span><span className="num block text-xs font-normal text-muted-foreground">{i.number || "Not posted"}</span></span> },
  { key: "supplier", header: "Supplier", cell: (i) => i.supplier_name },
  { key: "date", header: "Invoice date", cell: (i) => <span className="whitespace-nowrap">{date(i.invoice_date)}</span> },
  { key: "due", header: "Due", cell: (i) => <span className="whitespace-nowrap">{date(i.due_date)}</span> },
  { key: "amount", header: "Amount", align: "right", cell: (i) => <Amount value={i.amount} /> },
  { key: "match", header: "Match", cell: (i) => <MatchStatus status={i.match_status} /> },
  { key: "status", header: "Status", cell: (i) => <DocStatus status={i.status} /> },
];

function Invoices() {
  const url = useUrlState();
  const status = url.get("status");
  const q = useQuery({
    queryKey: ["finance", "supplier-invoices", status, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/finance/supplier-invoices/", { params: { query: { status: status || undefined, page: url.page } } })),
  });
  return (
    <Section actions={
      <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
        {[["", "All"], ["draft", "Draft"], ["submitted", "Awaiting approval"], ["approved", "Approved"], ["posted", "Posted"]].map(([v, label]) => (
          <Button key={v || "all"} size="sm" variant={status === v ? "secondary" : "ghost"} aria-pressed={status === v} onClick={() => url.set({ status: v })}>{label}</Button>
        ))}
      </div>
    }>
      <DataTable columns={columns} rows={q.data?.results} isLoading={q.isLoading} error={q.error} onRetry={q.refetch}
        rowHref={(i) => `/finance/payables/${i.id}`} caption="Supplier invoices"
        empty={<EmptyState icon={Receipt} title="No supplier invoices" description="Record a supplier's bill against what was received (goods receipt lines)." />} />
      {q.data && <PageNav page={url.page} count={q.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
    </Section>
  );
}

export function PayablesView() {
  const { can } = useSession();
  const url = useUrlState();
  const view = url.get("view") || (can("finance.supplier_invoice.read") ? "invoices" : "open");
  const asOf = url.get("as_of") || today();
  return (
    <>
      <PageHeader title="Payables" description="Supplier invoices are matched to the order and goods receipt before they're posted. A clean match approves itself; a price variance needs an approver."
        actions={can("finance.supplier_invoice.create") && (
          <Button asChild><Link href="/finance/payables/new"><Plus aria-hidden /> Record invoice</Link></Button>
        )} />
      <Tabs value={view} onValueChange={(v) => url.set({ view: v, status: null })} className="mb-4">
        <TabsList>
          {can("finance.supplier_invoice.read") && <TabsTrigger value="invoices">Supplier invoices</TabsTrigger>}
          {can("finance.open_item.read") && <TabsTrigger value="open">Open payables</TabsTrigger>}
          {can("finance.open_item.read") && <TabsTrigger value="ageing">Ageing</TabsTrigger>}
        </TabsList>
      </Tabs>
      {view === "invoices" && <Invoices />}
      {view === "open" && <Section title="Open payables"><OpenItemsTable kind="payable" page={url.page} onPage={(page) => url.set({ page })} /></Section>}
      {view === "ageing" && (
        <>
          <FilterBar><AsOf value={asOf} onChange={(v) => url.set({ as_of: v })} /></FilterBar>
          <Section title="Payables ageing" description="Outstanding by days past due, per supplier."><AgeingTable kind="payable" asOf={asOf} /></Section>
        </>
      )}
    </>
  );
}
