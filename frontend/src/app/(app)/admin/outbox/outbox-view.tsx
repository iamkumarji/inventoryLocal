"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge, type Tone } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type OutboxEvent = components["schemas"]["OutboxEvent"];
type Status = OutboxEvent["status"];
const TONE: Record<string, Tone> = { pending: "info", published: "approved", failed: "pending", dead: "rejected" };

export function OutboxView() {
  const { can } = useSession();
  const url = useUrlState();
  const queryClient = useQueryClient();
  const status = url.get("status") || "dead";
  const query = useQuery({
    queryKey: ["core", "outbox", status, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/admin/outbox-events/", { params: { query: { status: (status === "all" ? undefined : status) as Status | undefined, page: url.page } } })),
  });
  const retry = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/api/v1/admin/outbox-events/{id}/retry/", { params: { path: { id } } })),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["core", "outbox"] }); toast("Queued for another attempt"); },
  });
  const columns: Column<OutboxEvent>[] = [
    { key: "type", header: "Event", cell: (e) => <span className="num text-xs">{e.event_type}</span> },
    { key: "status", header: "Status", cell: (e) => <StatusBadge tone={TONE[e.status] ?? "neutral"}>{e.status}</StatusBadge> },
    { key: "attempts", header: "Attempts", align: "right", cell: (e) => <span className="num">{e.attempts}</span> },
    { key: "error", header: "Last error", cell: (e) => <span className="block max-w-[32rem] truncate text-xs text-muted-foreground" title={e.last_error}>{e.last_error || "—"}</span> },
    { key: "when", header: "Occurred", cell: (e) => <span className="text-muted-foreground">{dateTime(e.occurred_at)}</span> },
    { key: "actions", header: <span className="sr-only">Actions</span>, align: "right", cell: (e) => can("core.outbox_event.manage") && ["dead", "failed"].includes(e.status) && (
      <Button size="sm" variant="ghost" onClick={() => retry.mutate(e.id)} disabled={retry.isPending}>Retry</Button>
    ) },
  ];
  return (
    <>
      <PageHeader title="Event outbox" description="Side effects such as notifications run from here after a transaction commits. Stock and accounting never depend on it." />
      <Section actions={
        <div className="flex flex-wrap gap-1" role="group" aria-label="Status">
          {[["dead", "Dead letters"], ["failed", "Retrying"], ["pending", "Pending"], ["all", "All"]].map(([value, label]) => (
            <Button key={value} size="sm" variant={status === value ? "secondary" : "ghost"} onClick={() => url.set({ status: value === "dead" ? null : value })}>{label}</Button>
          ))}
        </div>
      }>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          empty={<EmptyState icon={ListChecks} title={status === "dead" ? "No dead letters" : "Nothing here"} description={status === "dead" ? "Every event has been delivered." : undefined} />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
