"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Scale, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ANY, FilterBar, WarehouseSelect } from "@/components/inventory/bits";
import { InvStatus } from "@/components/inventory/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { ADJUSTMENT_REASONS, useWarehouses, type Adjustment } from "@/lib/api/inventory";
import { date, money } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const STATUSES = { draft: "Draft", submitted: "Submitted", approved: "Approved", rejected: "Rejected", posted: "Posted", cancelled: "Cancelled" };

export function AdjustmentsView() {
  const { can } = useSession();
  const url = useUrlState();
  const wh = useWarehouses({ activeCompanyOnly: false });
  const status = url.get("status");
  const warehouse = url.get("warehouse");
  const reason = url.get("reason");
  const search = url.get("q");
  const [draft, setDraft] = useState(search);
  const query = useQuery({
    queryKey: ["inventory", "adjustments", status, warehouse, reason, search, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/inventory/adjustments/", {
      params: { query: { status: (status || undefined) as never, warehouse: warehouse || undefined, reason: (reason || undefined) as never, search: search || undefined, page: url.page } },
    })),
  });
  const columns: Column<Adjustment>[] = [
    { key: "number", header: "Adjustment", cell: (a) => <span className="num">{a.number || "Unposted draft"}<span className="block text-xs font-normal text-muted-foreground">{ADJUSTMENT_REASONS[a.reason] ?? a.reason}</span></span> },
    { key: "date", header: "Posting date", cell: (a) => <span className="whitespace-nowrap">{date(a.posting_date)}</span> },
    { key: "wh", header: "Warehouse", cell: (a) => <span className="num">{wh.label(a.warehouse)}</span> },
    { key: "lines", header: "Lines", align: "right", cell: (a) => <span className="num">{a.lines.length}</span> },
    { key: "amount", header: "Value", align: "right", cell: (a) => <span className="num">{a.status === "draft" ? "—" : money(a.amount, a.currency || "INR")}</span> },
    { key: "status", header: "Status", cell: (a) => <InvStatus kind="doc" status={a.status} /> },
  ];
  return (
    <>
      <PageHeader title="Stock adjustments" description="Corrections to stock: found, damaged, expired or lost goods and opening balances. Each needs approval before it posts."
        actions={can("inventory.stock_adjustment.create") && <Button asChild><Link href="/inventory/adjustments/new"><Plus aria-hidden /> New adjustment</Link></Button>} />
      <Section
        actions={
          <FilterBar>
            <form onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }} className="relative w-full sm:w-44">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Number or notes" className="h-9 pl-8" aria-label="Search adjustments" />
            </form>
            <Select value={status || ANY} onValueChange={(v) => url.set({ status: v === ANY ? null : v })}>
              <SelectTrigger className="w-full sm:w-36" aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any status</SelectItem>
                {Object.entries(STATUSES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={reason || ANY} onValueChange={(v) => url.set({ reason: v === ANY ? null : v })}>
              <SelectTrigger className="w-full sm:w-40" aria-label="Reason"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any reason</SelectItem>
                {Object.entries(ADJUSTMENT_REASONS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
            <WarehouseSelect value={warehouse} onChange={(v) => url.set({ warehouse: v })} allowAny className="sm:w-44" ariaLabel="Warehouse" />
          </FilterBar>
        }
      >
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(a) => `/inventory/adjustments/${a.id}`} caption="Stock adjustments"
          empty={<EmptyState icon={Scale} title="No adjustments match" description="Create one to record found, damaged or lost stock, or to load opening balances." />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
