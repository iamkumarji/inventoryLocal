"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCheck, Inbox, UserRoundCog } from "lucide-react";
import Link from "next/link";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ApprovalStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { useInbox } from "@/lib/api/hooks";
import type { components } from "@/lib/api/schema";
import { ago, dateTime, money } from "@/lib/format";
import { useUrlState } from "@/lib/use-url-state";

type Row = components["schemas"]["RequestList"];

const document: Column<Row> = {
  key: "document",
  header: "Request",
  cell: (r) => (
    <span className="block max-w-[38ch]">
      <span className="block truncate">{r.title}</span>
      <span className="block truncate text-xs font-normal text-muted-foreground">
        {r.document_label} {r.document_number}
      </span>
    </span>
  ),
};
const amount: Column<Row> = { key: "amount", header: "Amount", align: "right", cell: (r) => <span className="num">{money(r.amount, r.currency || "INR")}</span> };

const INBOX_COLUMNS: Column<Row>[] = [
  document,
  amount,
  { key: "step", header: "Your step", cell: (r) => r.current_step_name },
  { key: "by", header: "Requested by", cell: (r) => r.requested_by.full_name },
  { key: "age", header: "Waiting", cell: (r) => <span className="text-muted-foreground">{ago(r.submitted_at)}</span> },
];

const LIST_COLUMNS: Column<Row>[] = [
  document,
  amount,
  { key: "status", header: "Status", cell: (r) => <ApprovalStatus status={r.status} /> },
  { key: "step", header: "Current step", cell: (r) => r.current_step_name ?? "—" },
  { key: "by", header: "Requested by", cell: (r) => r.requested_by.full_name },
  { key: "submitted", header: "Submitted", cell: (r) => <span className="text-muted-foreground">{dateTime(r.submitted_at)}</span> },
];

export function ApprovalsView() {
  const url = useUrlState();
  const tab = url.get("tab") || "inbox";
  const status = url.get("status");
  const inbox = useInbox();
  const list = useQuery({
    queryKey: ["approvals", "requests", tab, status, url.page],
    queryFn: () =>
      unwrap(api.GET("/api/v1/approvals/requests/", {
        params: { query: { mine: tab === "mine" ? true : undefined, status: (status || undefined) as Row["status"] | undefined, page: url.page } },
      })),
    enabled: tab !== "inbox",
  });

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Decide requests routed to you and follow the ones you submitted."
        actions={
          <Button variant="outline" asChild>
            <Link href="/approvals/delegations"><UserRoundCog aria-hidden /> Delegations</Link>
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(value) => url.set({ tab: value === "inbox" ? null : value, status: null })} className="mb-4">
        <TabsList>
          <TabsTrigger value="inbox">
            Waiting for me{inbox.data && inbox.data.length > 0 && <span className="num ml-1.5 rounded-sm bg-primary px-1.5 text-xs text-primary-foreground">{inbox.data.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="mine">My requests</TabsTrigger>
          <TabsTrigger value="all">All I can see</TabsTrigger>
        </TabsList>
      </Tabs>

      <Section
        actions={tab !== "inbox" && (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
            {["", "pending", "approved", "rejected", "withdrawn"].map((s) => (
              <Button key={s || "any"} size="sm" variant={status === s ? "secondary" : "ghost"} onClick={() => url.set({ status: s })}>
                {s ? s.charAt(0).toUpperCase() + s.slice(1) : "Any status"}
              </Button>
            ))}
          </div>
        )}
      >
        {tab === "inbox" ? (
          <DataTable columns={INBOX_COLUMNS} rows={inbox.data} isLoading={inbox.isLoading} error={inbox.error}
            onRetry={inbox.refetch} rowHref={(r) => `/approvals/${r.id}`} caption="Requests waiting for your decision"
            empty={<EmptyState icon={CheckCheck} title="Nothing is waiting for you"
              description="When a request reaches a step you approve, it appears here and you get a notification." />} />
        ) : (
          <>
            <DataTable columns={LIST_COLUMNS} rows={list.data?.results} isLoading={list.isLoading} error={list.error}
              onRetry={list.refetch} rowHref={(r) => `/approvals/${r.id}`}
              empty={<EmptyState icon={Inbox} title={tab === "mine" ? "You haven't submitted any requests" : "No requests match"}
                description="Requests are created from documents such as purchase orders once those modules are enabled." />} />
            {list.data && <PageNav page={url.page} count={list.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
          </>
        )}
      </Section>
    </>
  );
}
