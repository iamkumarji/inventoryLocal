"use client";

import { useQuery } from "@tanstack/react-query";
import { BookOpen, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { Amount } from "@/components/finance/amount";
import { DocStatus } from "@/components/finance/controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import type { JournalEntry } from "@/lib/api/finance";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

export function sourceLabel(e: Pick<JournalEntry, "source_type" | "source_module">) {
  if (e.source_type === "manual") return "Manual";
  const map: Record<string, string> = {
    "finance.supplier_invoice": "Supplier invoice",
    "finance.payment": "Payment",
    "finance.year_end": "Year-end close",
  };
  return map[e.source_type] ?? (e.source_type || e.source_module);
}

const columns: Column<JournalEntry>[] = [
  { key: "number", header: "Entry", cell: (e) => <span className="num">{e.number || "Draft"}</span> },
  { key: "date", header: "Date", cell: (e) => <span className="whitespace-nowrap">{date(e.entry_date)}</span> },
  { key: "narration", header: "Narration", cell: (e) => <span className="block max-w-[44ch] truncate">{e.narration}</span> },
  { key: "source", header: "Source", cell: (e) => <span className="text-muted-foreground">{sourceLabel(e)}</span> },
  { key: "total", header: "Amount", align: "right", cell: (e) => <Amount value={e.total} /> },
  {
    key: "status", header: "Status", cell: (e) => (
      <span className="flex flex-wrap gap-1">
        <DocStatus status={e.status} />
        {e.reversed_by && <StatusBadge tone="neutral">Reversed</StatusBadge>}
        {e.is_reversal && <StatusBadge tone="info">Reversal</StatusBadge>}
      </span>
    ),
  },
];

export function JournalsView() {
  const { can } = useSession();
  const url = useUrlState();
  const status = url.get("status");
  const search = url.get("q");
  const [draft, setDraft] = useState(search);
  const q = useQuery({
    queryKey: ["finance", "journals", status, search, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/finance/journal-entries/", {
      params: { query: { status: (status || undefined) as "draft" | "posted" | undefined, search: search || undefined, page: url.page } },
    })),
  });
  return (
    <>
      <PageHeader title="Journals" description="Every accounting entry. Posted entries are never edited; a mistake is corrected by reversing it."
        actions={can("finance.journal_entry.create") && (
          <Button asChild><Link href="/finance/journals/new"><Plus aria-hidden /> New journal</Link></Button>
        )} />
      <Section actions={
        <div className="flex flex-wrap items-center gap-2">
          <form className="relative" onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }}>
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Number or narration" className="h-9 w-56 pl-8" aria-label="Search journals" />
          </form>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
            {[["", "All"], ["draft", "Drafts"], ["posted", "Posted"]].map(([value, label]) => (
              <Button key={value || "all"} size="sm" variant={status === value ? "secondary" : "ghost"} aria-pressed={status === value}
                onClick={() => url.set({ status: value })}>{label}</Button>
            ))}
          </div>
        </div>
      }>
        <DataTable columns={columns} rows={q.data?.results} isLoading={q.isLoading} error={q.error} onRetry={q.refetch}
          rowHref={(e) => `/finance/journals/${e.id}`} caption="Journal entries"
          empty={<EmptyState icon={BookOpen} title="No journal entries match" description="Postings from invoices and payments, and manual journals, appear here." />} />
        {q.data && <PageNav page={url.page} count={q.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
