"use client";

import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { ScrollText, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type Event = components["schemas"]["AuditEvent"];
type Outcome = Event["outcome"];
const OUTCOME_TONE = { success: "approved", denied: "rejected", failure: "pending" } as const;

function render(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function Changes({ changes }: { changes: Record<string, unknown> }) {
  const entries = Object.entries(changes ?? {});
  if (!entries.length) return <p className="text-sm text-muted-foreground">No field changes recorded.</p>;
  const isDiff = entries.every(([, v]) => v && typeof v === "object" && "from" in (v as object) && "to" in (v as object));
  if (!isDiff) return <pre className="num overflow-x-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(changes, null, 2)}</pre>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Field</TableHead><TableHead>Before</TableHead><TableHead>After</TableHead></TableRow></TableHeader>
      <TableBody>{entries.map(([field, v]) => {
        const d = v as { from: unknown; to: unknown };
        return (
          <TableRow key={field}>
            <TableCell className="font-medium">{field}</TableCell>
            <TableCell className="text-status-rejected line-through decoration-status-rejected/40">{render(d.from)}</TableCell>
            <TableCell className="text-status-approved">{render(d.to)}</TableCell>
          </TableRow>
        );
      })}</TableBody>
    </Table>
  );
}

export function AuditView() {
  const { can } = useSession();
  const url = useUrlState();
  const [selected, setSelected] = useState<Event | null>(null);
  const [actionDraft, setActionDraft] = useState(url.get("action"));
  const filters = { action_prefix: url.get("action") || undefined, outcome: (url.get("outcome") || undefined) as Outcome | undefined, resource_type: url.get("type") || undefined };
  const events = useInfiniteQuery({
    queryKey: ["audit", "events", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => unwrap(api.GET("/api/v1/audit/events/", { params: { query: { ...filters, cursor: pageParam } } })),
    getNextPageParam: (last) => (last.next ? new URL(last.next, "http://x").searchParams.get("cursor") ?? undefined : undefined),
  });
  const verify = useMutation({
    mutationFn: () => unwrap(api.GET("/api/v1/audit/events/verify-chain/")),
    onSuccess: (r) => {
      const result = r as { valid: boolean; checked: number; unsealed?: number; problem?: string };
      if (result.valid) toast.success(`Chain intact: ${result.checked} sealed events verified${result.unsealed ? `, ${result.unsealed} awaiting sealing` : ""}.`);
      else toast.error(`Tampering detected: ${result.problem}. Escalate to security immediately.`);
    },
  });
  const rows = events.data?.pages.flatMap((p) => p.results) ?? [];

  return (
    <>
      <PageHeader title="Audit log" description="Every sign-in, permission change, approval and posting. Entries can't be edited or deleted."
        actions={can("audit.audit_event.manage") && <Button variant="outline" onClick={() => verify.mutate()} disabled={verify.isPending}><ShieldCheck aria-hidden /> Verify integrity</Button>} />
      <Section actions={
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={(e) => { e.preventDefault(); url.set({ action: actionDraft }); }}>
            <Input value={actionDraft} onChange={(e) => setActionDraft(e.target.value)} placeholder="Action starts with, e.g. auth." className="num h-9 w-60" aria-label="Filter by action" />
          </form>
          <Select value={url.get("outcome") || "any"} onValueChange={(v) => url.set({ outcome: v === "any" ? null : v })}>
            <SelectTrigger className="w-36" aria-label="Outcome"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any outcome</SelectItem><SelectItem value="success">Success</SelectItem>
              <SelectItem value="denied">Denied</SelectItem><SelectItem value="failure">Failure</SelectItem>
            </SelectContent>
          </Select>
        </div>
      }>
        {events.isLoading ? <RowsSkeleton /> : events.error ? <ErrorState error={events.error} onRetry={events.refetch} /> : rows.length === 0 ? (
          <EmptyState icon={ScrollText} title="No events match these filters" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow className="hover:bg-transparent">
                <TableHead className="text-xs">When</TableHead><TableHead className="text-xs">Who</TableHead><TableHead className="text-xs">Action</TableHead>
                <TableHead className="text-xs">Summary</TableHead><TableHead className="text-xs">Outcome</TableHead>
              </TableRow></TableHeader>
              <TableBody>{rows.map((e) => (
                <TableRow key={e.id} className="cursor-pointer" onClick={() => setSelected(e)}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{dateTime(e.occurred_at)}</TableCell>
                  <TableCell className="max-w-[16rem] truncate">{e.actor_label || e.actor_type}</TableCell>
                  <TableCell><button type="button" className="num text-left text-xs hover:underline" onClick={() => setSelected(e)}>{e.action}</button></TableCell>
                  <TableCell className="max-w-[24rem] truncate text-muted-foreground">{e.summary}</TableCell>
                  <TableCell><StatusBadge tone={OUTCOME_TONE[e.outcome ?? "success"]}>{e.outcome}</StatusBadge></TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
        )}
        {events.hasNextPage && <div className="border-t px-5 py-3"><Button size="sm" variant="outline" onClick={() => events.fetchNextPage()} disabled={events.isFetchingNextPage}>Load older</Button></div>}
      </Section>
      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="num text-base">{selected.action}</SheetTitle>
                <SheetDescription>{dateTime(selected.occurred_at)} by {selected.actor_label || selected.actor_type}</SheetDescription>
              </SheetHeader>
              <div className="grid gap-5 px-4 pb-6">
                <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Outcome</dt><dd><StatusBadge tone={OUTCOME_TONE[selected.outcome ?? "success"]}>{selected.outcome}</StatusBadge></dd>
                  <dt className="text-muted-foreground">Record</dt><dd className="num break-all text-xs">{selected.resource_type} {selected.resource_id}</dd>
                  <dt className="text-muted-foreground">Summary</dt><dd>{selected.summary || "—"}</dd>
                  <dt className="text-muted-foreground">From</dt><dd className="num text-xs">{selected.ip ?? "—"}</dd>
                  <dt className="text-muted-foreground">Request</dt><dd className="num break-all text-xs">{selected.request_id}</dd>
                  <dt className="text-muted-foreground">Sealed</dt><dd>{selected.sealed ? "Yes, in the hash chain" : "Not yet (sealed within a minute)"}</dd>
                </dl>
                <div><p className="type-section mb-2">Changes</p><Changes changes={selected.changes as Record<string, unknown>} /></div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
