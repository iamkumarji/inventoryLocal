"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListTodo } from "lucide-react";
import Link from "next/link";

import { DueLabel, TransitionButtons } from "@/components/collaboration/tasks";
import { PageNav } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { StateBadge } from "@/components/production/status";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import type { Task } from "@/lib/api/production";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const FILTERS = { active: "To do", done: "Done", cancelled: "Cancelled" } as const;

async function myTasks(status: Task["status"], page = 1) {
  return unwrap(api.GET("/api/v1/collaboration/my-tasks/", { params: { query: { status, page, page_size: 100 } } }));
}

export function MyTasksView() {
  const { can } = useSession();
  const url = useUrlState();
  const queryClient = useQueryClient();
  const filter = (url.get("filter") || "active") as keyof typeof FILTERS;
  const query = useQuery({
    queryKey: ["collaboration", "my-tasks", filter, url.page],
    queryFn: async () => {
      if (filter !== "active") return myTasks(filter, url.page);
      // "To do" is open and in-progress work together, soonest due first.
      const [open, started] = await Promise.all([myTasks("open"), myTasks("in_progress")]);
      const results = [...started.results, ...open.results].sort((a, b) =>
        (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999") || b.created_at.localeCompare(a.created_at));
      return { count: results.length, results };
    },
  });
  const rows = query.data?.results ?? [];
  return (
    <>
      <PageHeader title="My tasks" description="Work assigned to you in this company, soonest due first." />
      <Tabs value={filter} onValueChange={(v) => url.set({ filter: v === "active" ? null : v })} className="mb-4">
        <TabsList>{Object.entries(FILTERS).map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}</TabsList>
      </Tabs>
      <Section>
        {query.error ? <ErrorState error={query.error} onRetry={query.refetch} /> : query.isLoading ? <RowsSkeleton /> : rows.length === 0 ? (
          <EmptyState icon={ListTodo} title={filter === "active" ? "Nothing to do" : "No tasks here"} description="Tasks assigned to you appear here." />
        ) : (
          <ul className="divide-y" aria-label="My tasks">
            {rows.map((t) => (
              <li key={t.id} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {can("collaboration.task.read")
                      ? <Link href={`/collaboration/tasks/${t.id}`} className="font-medium underline-offset-4 hover:underline">{t.title}</Link>
                      : <p className="font-medium">{t.title}</p>}
                    <StateBadge kind="task" value={t.status} />
                    {t.priority !== "normal" && <StateBadge kind="priority" value={t.priority} />}
                  </div>
                  {t.description && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{t.description}</p>}
                  <p className="mt-1 text-sm"><DueLabel task={t} /></p>
                </div>
                <TransitionButtons task={t} self large onChanged={() => queryClient.invalidateQueries({ queryKey: ["collaboration", "my-tasks"] })} />
              </li>
            ))}
          </ul>
        )}
        {query.data && filter !== "active" && <PageNav page={url.page} count={query.data.count} pageSize={100} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
