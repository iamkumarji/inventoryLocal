"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Wallet } from "lucide-react";
import Link from "next/link";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { Amount } from "@/components/finance/amount";
import { ApplyCreditDialog } from "@/components/finance/apply-credit";
import { DocStatus } from "@/components/finance/controls";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { MODE_LABEL, type Payment } from "@/lib/api/finance";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

export const KIND_LABEL = { supplier_payment: "Supplier payment", customer_receipt: "Customer receipt" } as const;

const columns: Column<Payment>[] = [
  { key: "number", header: "Payment", cell: (p) => <span><span className="num block">{p.number || "Not posted"}</span><span className="block text-xs font-normal text-muted-foreground">{KIND_LABEL[p.kind]}</span></span> },
  { key: "partner", header: "Paid to / received from", cell: (p) => p.partner_name },
  { key: "date", header: "Date", cell: (p) => <span className="whitespace-nowrap">{date(p.payment_date)}</span> },
  { key: "mode", header: "Mode", cell: (p) => <span>{MODE_LABEL[p.mode]}{p.reference && <span className="block text-xs text-muted-foreground">{p.reference}</span>}</span> },
  { key: "amount", header: "Amount", align: "right", cell: (p) => <Amount value={p.amount} /> },
  { key: "status", header: "Status", cell: (p) => <DocStatus status={p.status} /> },
];

export function PaymentsView() {
  const { can } = useSession();
  const url = useUrlState();
  const kind = url.get("kind");
  const status = url.get("status");
  const q = useQuery({
    queryKey: ["finance", "payments", kind, status, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/finance/payments/", {
      params: { query: { kind: (kind || undefined) as Payment["kind"] | undefined, status: status || undefined, page: url.page } },
    })),
  });
  return (
    <>
      <PageHeader title="Payments" description="Money out to suppliers needs a second person to approve it and a verified supplier bank account to post. Customer receipts post without approval."
        actions={can("finance.payment.create") && <>
          <Button variant="outline" asChild><Link href="/finance/payments/new?kind=customer_receipt"><ArrowDownLeft aria-hidden /> Record receipt</Link></Button>
          <Button asChild><Link href="/finance/payments/new?kind=supplier_payment"><ArrowUpRight aria-hidden /> New payment</Link></Button>
        </>} />
      <Tabs value={kind || "all"} onValueChange={(v) => url.set({ kind: v === "all" ? null : v })} className="mb-4">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="supplier_payment">Supplier payments</TabsTrigger>
          <TabsTrigger value="customer_receipt">Customer receipts</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
        <Section actions={
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
            {[["", "Any status"], ["draft", "Draft"], ["submitted", "Awaiting approval"], ["approved", "Approved"], ["posted", "Posted"]].map(([v, label]) => (
              <Button key={v || "any"} size="sm" variant={status === v ? "secondary" : "ghost"} aria-pressed={status === v} onClick={() => url.set({ status: v })}>{label}</Button>
            ))}
          </div>
        }>
          <DataTable columns={columns} rows={q.data?.results} isLoading={q.isLoading} error={q.error} onRetry={q.refetch}
            rowHref={(p) => `/finance/payments/${p.id}`} caption="Payments and receipts"
            empty={<EmptyState icon={Wallet} title="No payments match" description="Payments settle open supplier invoices; receipts settle customer invoices. Anything unallocated stays on account." />} />
          {q.data && <PageNav page={url.page} count={q.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
        </Section>
        {can("finance.payment.create") && can("finance.open_item.read") && (
          <Section title="Applying credits to invoices"
            description="Offset a credit note or an on-account payment against an open invoice of the same partner. No money moves; both open items are settled by the amount.">
            <div className="flex flex-wrap gap-2 px-5 py-4">
              <ApplyCreditDialog kind="receivable" label="Apply customer credit" />
              <ApplyCreditDialog kind="payable" label="Apply supplier credit" />
            </div>
          </Section>
        )}
      </div>
    </>
  );
}
