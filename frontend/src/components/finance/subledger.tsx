"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCheck, Clock } from "lucide-react";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Amount } from "@/components/finance/amount";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { api, unwrap } from "@/lib/api/client";
import { AGEING_BUCKETS, type AgeingRow, type OpenItem, sumDecimals, today } from "@/lib/api/finance";
import { date } from "@/lib/format";

const DOC_LABEL: Record<string, string> = {
  "finance.supplier_invoice": "Supplier invoice",
  "finance.payment.advance": "Advance / on account",
  "sales.invoice": "Sales invoice",
  "sales.sales_return": "Credit note",
};

function overdueDays(due: string): number {
  const ms = new Date(`${today()}T00:00:00`).getTime() - new Date(`${due}T00:00:00`).getTime();
  return Math.round(ms / 86_400_000);
}

export function OpenItemsTable({ kind, page, onPage, openOnly = true }: {
  kind: "payable" | "receivable";
  page: number;
  onPage: (page: number) => void;
  openOnly?: boolean;
}) {
  const q = useQuery({
    queryKey: ["finance", "open-items", kind, openOnly, page],
    queryFn: () => unwrap(api.GET("/api/v1/finance/open-items/", {
      params: { query: { kind, is_open: openOnly ? true : undefined, page, ordering: "due_date" } },
    })),
  });
  const columns: Column<OpenItem>[] = [
    { key: "number", header: "Document", cell: (i) => <span><span className="num block">{i.number}</span><span className="block text-xs text-muted-foreground">{DOC_LABEL[i.document_type] ?? i.document_type}</span></span> },
    { key: "partner", header: kind === "payable" ? "Supplier" : "Customer", cell: (i) => i.partner_name },
    { key: "date", header: "Date", cell: (i) => <span className="whitespace-nowrap">{date(i.document_date)}</span> },
    {
      key: "due", header: "Due", cell: (i) => {
        const late = i.is_open && overdueDays(i.due_date) > 0;
        return (
          <span className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
            {date(i.due_date)}
            {late && <StatusBadge tone="rejected">{overdueDays(i.due_date)} d overdue</StatusBadge>}
          </span>
        );
      },
    },
    { key: "amount", header: "Amount", align: "right", cell: (i) => <Amount value={i.amount} /> },
    { key: "settled", header: "Settled", align: "right", cell: (i) => <Amount value={i.settled} muteZero /> },
    { key: "outstanding", header: "Outstanding", align: "right", cell: (i) => <Amount value={i.outstanding} className="font-semibold" /> },
  ];
  return (
    <>
      <DataTable columns={columns} rows={q.data?.results} isLoading={q.isLoading} error={q.error} onRetry={q.refetch}
        caption={`Open ${kind === "payable" ? "payables" : "receivables"}`}
        empty={<EmptyState icon={CheckCheck} title={`Nothing ${kind === "payable" ? "to pay" : "to collect"}`}
          description={kind === "payable" ? "Posted supplier invoices appear here until they're paid." : "Posted sales invoices appear here until customers pay."} />} />
      {q.data && <PageNav page={page} count={q.data.count} pageSize={50} onPage={onPage} />}
    </>
  );
}

/** Ageing by partner. Advances and credit notes are negative and reduce a partner's total. */
export function AgeingTable({ kind, asOf }: { kind: "payable" | "receivable"; asOf: string }) {
  const q = useQuery({
    queryKey: ["finance", "ageing", kind, asOf],
    queryFn: async () => (await unwrap(api.GET("/api/v1/finance/open-items/ageing/", { params: { query: { kind, as_of: asOf } } }))) as unknown as AgeingRow[],
  });
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  if (!q.data) return <RowsSkeleton />;
  if (q.data.length === 0) return <EmptyState icon={Clock} title="Nothing outstanding on this date" />;
  const rows = q.data;
  return (
    <LedgerTable caption={`${kind === "payable" ? "Payables" : "Receivables"} ageing as of ${asOf}`} columns={[
      { key: "partner", header: kind === "payable" ? "Supplier" : "Customer" },
      ...AGEING_BUCKETS.map((b) => ({ key: b, header: b === "Not due" ? b : `${b} days`, align: "right" as const })),
      { key: "total", header: "Total", align: "right" },
    ]} footer={
      <Row className="hover:bg-transparent">
        <Cell className="font-semibold">Total</Cell>
        {AGEING_BUCKETS.map((b) => <Cell key={b} align="right" className="font-semibold"><Amount value={sumDecimals(rows.map((r) => r[b]))} currency={false} muteZero /></Cell>)}
        <Cell align="right" className="font-bold"><Amount value={sumDecimals(rows.map((r) => r.total))} /></Cell>
      </Row>
    }>
      {rows.map((r) => (
        <Row key={r.partner_id}>
          <Cell className="min-w-40 font-sans font-medium">{r.partner}</Cell>
          {AGEING_BUCKETS.map((b, i) => (
            <Cell key={b} align="right" className={i >= 3 ? "text-status-rejected" : undefined}><Amount value={r[b]} currency={false} muteZero /></Cell>
          ))}
          <Cell align="right" className="font-semibold"><Amount value={r.total} /></Cell>
        </Row>
      ))}
    </LedgerTable>
  );
}
