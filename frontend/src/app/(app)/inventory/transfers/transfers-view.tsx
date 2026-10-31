"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, ArrowRight, Plus } from "lucide-react";
import Link from "next/link";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ANY, FilterBar, WarehouseSelect } from "@/components/inventory/bits";
import { InvStatus } from "@/components/inventory/status";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { useWarehouses, type Transfer } from "@/lib/api/inventory";
import { ago, date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const STATUSES = { draft: "Draft", dispatched: "In transit", received: "Received", cancelled: "Cancelled" };

export function TransfersView() {
  const { can } = useSession();
  const url = useUrlState();
  const wh = useWarehouses({ activeCompanyOnly: false });
  const status = url.get("status");
  const from = url.get("from");
  const to = url.get("to");
  const query = useQuery({
    queryKey: ["inventory", "transfers", status, from, to, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/inventory/transfers/", {
      params: { query: { status: (status || undefined) as never, from_warehouse: from || undefined, to_warehouse: to || undefined, page: url.page } },
    })),
  });
  const columns: Column<Transfer>[] = [
    { key: "number", header: "Transfer", cell: (t) => <span className="num">{t.number || "Draft"}</span> },
    { key: "route", header: "Route", cell: (t) => (
      <span className="num inline-flex items-center gap-1.5 whitespace-nowrap">{wh.label(t.from_warehouse)}<ArrowRight className="size-3.5 text-muted-foreground" aria-label="to" />{wh.label(t.to_warehouse)}</span>
    ) },
    { key: "lines", header: "Lines", align: "right", cell: (t) => <span className="num">{t.lines.length}</span> },
    { key: "status", header: "Status", cell: (t) => <InvStatus kind="transfer" status={t.status} /> },
    { key: "when", header: "Dispatched / received", cell: (t) => <span className="whitespace-nowrap text-muted-foreground">{t.received_on ? `Received ${date(t.received_on)}` : t.dispatched_on ? `Dispatched ${date(t.dispatched_on)}` : `Created ${ago(t.created_at)}`}</span> },
  ];
  return (
    <>
      <PageHeader title="Stock transfers" description="Move stock between warehouses of the same company. Dispatch puts it in transit; the destination receives it."
        actions={can("inventory.stock_transfer.create") && <Button asChild><Link href="/inventory/transfers/new"><Plus aria-hidden /> New transfer</Link></Button>} />
      <Section
        actions={
          <FilterBar>
            <Select value={status || ANY} onValueChange={(v) => url.set({ status: v === ANY ? null : v })}>
              <SelectTrigger className="w-full sm:w-36" aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any status</SelectItem>
                {Object.entries(STATUSES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
            <WarehouseSelect value={from} onChange={(v) => url.set({ from: v })} allowAny anyLabel="From any warehouse" className="sm:w-48" ariaLabel="From warehouse" />
            <WarehouseSelect value={to} onChange={(v) => url.set({ to: v })} allowAny anyLabel="To any warehouse" className="sm:w-48" ariaLabel="To warehouse" />
          </FilterBar>
        }
      >
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(t) => `/inventory/transfers/${t.id}`} caption="Stock transfers"
          empty={<EmptyState icon={ArrowLeftRight} title="No transfers match" description="Transfers you send, and those coming to warehouses you receive for, appear here." />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
