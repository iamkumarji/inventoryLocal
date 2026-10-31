"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BellOff, CheckCheck } from "lucide-react";
import Link from "next/link";

import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api/client";
import { ago } from "@/lib/format";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";

const CATEGORY_LABEL: Record<string, string> = { approval: "Approval", task: "Task", security: "Security", system: "System" };

export function NotificationsView() {
  const url = useUrlState();
  const unreadOnly = url.get("filter") !== "all";
  const queryClient = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: ["notifications", "list", unreadOnly],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/api/v1/notifications/", {
        params: { query: { unread: unreadOnly || undefined, cursor: pageParam } },
      })),
    getNextPageParam: (last) => (last.next ? new URL(last.next, "http://x").searchParams.get("cursor") ?? undefined : undefined),
  });
  const markRead = useMutation({
    mutationFn: (ids?: string[]) => unwrap(api.POST("/api/v1/notifications/mark-read/", { body: ids ? { ids } : {} })),
    onSuccess: (data) => {
      queryClient.setQueryData(["notifications", "unread"], data);
      queryClient.invalidateQueries({ queryKey: ["notifications", "list"] });
    },
  });
  const items = list.data?.pages.flatMap((p) => p.results) ?? [];

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Approvals, security alerts and system messages for you."
        actions={<Button variant="outline" onClick={() => markRead.mutate(undefined)} disabled={markRead.isPending}><CheckCheck aria-hidden /> Mark all as read</Button>}
      />
      <Section
        actions={
          <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
            <Button size="sm" variant={unreadOnly ? "secondary" : "ghost"} onClick={() => url.set({ filter: null })}>Unread</Button>
            <Button size="sm" variant={!unreadOnly ? "secondary" : "ghost"} onClick={() => url.set({ filter: "all" })}>All</Button>
          </div>
        }
      >
        {list.isLoading ? <RowsSkeleton /> : list.error ? <ErrorState error={list.error} onRetry={list.refetch} /> :
          items.length === 0 ? (
            <EmptyState icon={BellOff} title={unreadOnly ? "No unread notifications" : "No notifications yet"} />
          ) : (
            <ul className="divide-y">
              {items.map((n) => (
                <li key={n.id} className={cn("flex items-start gap-4 px-5 py-3.5", !n.read_at && "bg-status-info/5")}>
                  <span aria-hidden className={cn("mt-2 size-2 shrink-0 rounded-full", n.read_at ? "bg-transparent" : "bg-status-info")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {n.link ? (
                        <Link href={n.link} onClick={() => !n.read_at && markRead.mutate([n.id])} className="font-medium hover:underline">
                          {n.title}
                        </Link>
                      ) : <p className="font-medium">{n.title}</p>}
                      <StatusBadge tone={n.severity === "critical" ? "rejected" : n.severity === "warning" ? "pending" : "neutral"}>
                        {CATEGORY_LABEL[n.category] ?? n.category}
                      </StatusBadge>
                    </div>
                    {n.body && <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p>}
                    <p className="mt-1 text-xs text-muted-foreground">{ago(n.created_at)}</p>
                  </div>
                  {!n.read_at && (
                    <Button size="sm" variant="ghost" onClick={() => markRead.mutate([n.id])}>Mark read</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        {list.hasNextPage && (
          <div className="border-t px-5 py-3">
            <Button variant="outline" size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>Load older</Button>
          </div>
        )}
      </Section>
    </>
  );
}
