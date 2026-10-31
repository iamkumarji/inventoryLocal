"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookCheck, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState, ErrorState, PageSkeleton, RowsSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { ActionDialog, Facts } from "@/components/production/action-dialog";
import { StateBadge } from "@/components/production/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { dec, problemMessage, today, usePersonLabel, type DepreciationRun } from "@/lib/api/production";
import { dateTime, money } from "@/lib/format";
import { useSession } from "@/lib/session";

import { monthLabel } from "../depreciation-view";

type Line = { asset: string; asset_code: string; method?: string; opening_book_value: string; amount: string; book_value_after: string; days: number };

function Lines({ lines }: { lines: Line[] }) {
  const total = dec.add(...lines.map((l) => l.amount));
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader><TableRow className="hover:bg-transparent">
          <TableHead>Asset</TableHead><TableHead className="hidden text-right sm:table-cell">Opening book value</TableHead><TableHead className="hidden text-right sm:table-cell">Days</TableHead>
          <TableHead className="text-right">Depreciation</TableHead><TableHead className="text-right">Book value after</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.asset}>
              <TableCell><Link href={`/assets/${l.asset}`} className="num font-medium underline-offset-4 hover:underline">{l.asset_code}</Link>{l.method && <span className="ml-2 text-xs text-muted-foreground uppercase">{l.method}</span>}</TableCell>
              <TableCell className="num hidden text-right sm:table-cell">{money(l.opening_book_value)}</TableCell>
              <TableCell className="num hidden text-right sm:table-cell">{l.days}</TableCell>
              <TableCell className="num text-right font-medium">{money(l.amount)}</TableCell>
              <TableCell className="num text-right">{money(l.book_value_after)}</TableCell>
            </TableRow>
          ))}
          <TableRow className="hover:bg-transparent">
            <TableCell className="font-semibold">Total</TableCell><TableCell className="hidden sm:table-cell" /><TableCell className="hidden sm:table-cell" />
            <TableCell className="num text-right font-semibold">{money(total)}</TableCell><TableCell />
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { withStepUp } = useStepUp();
  const person = usePersonLabel();
  const queryClient = useQueryClient();
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reversalDate, setReversalDate] = useState(today());
  const key = ["assets", "run", id];
  const query = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/api/v1/assets/depreciation-runs/{id}/", { params: { path: { id } } })) });
  const preview = useQuery({
    queryKey: ["assets", "run", id, "preview"],
    queryFn: () => unwrap(api.GET("/api/v1/assets/depreciation-runs/{id}/preview/", { params: { path: { id } } })),
    enabled: query.data?.status === "draft",
  });
  const onDone = (run: DepreciationRun) => {
    queryClient.setQueryData(key, run);
    queryClient.invalidateQueries({ queryKey: ["assets"] });
  };
  const post = useMutation({
    mutationFn: () => {
      const k = idempotencyKey(); // reused if the step-up check makes us retry
      return withStepUp(() => unwrap(api.POST("/api/v1/assets/depreciation-runs/{id}/post/", {
        params: { path: { id }, header: { "Idempotency-Key": k } }, body: { version: query.data!.version },
      })));
    },
    onSuccess: (run) => { onDone(run); toast(`Depreciation for ${monthLabel(run.period)} posted: ${money(run.total_amount)}`); },
    onError: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const reverse = useMutation({
    mutationFn: () => {
      const k = idempotencyKey();
      return withStepUp(() => unwrap(api.POST("/api/v1/assets/depreciation-runs/{id}/reverse/", {
        params: { path: { id }, header: { "Idempotency-Key": k } }, body: { reason, reversal_date: reversalDate || null, version: query.data!.version },
      })));
    },
    onSuccess: (run) => { onDone(run); setReverseOpen(false); toast("Run reversed; the month can be run again"); },
    onError: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const run = query.data!;
  const lines: Line[] = run.status === "draft" ? (preview.data ?? []) : run.entries;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Depreciation", href: "/assets/depreciation" }, { label: monthLabel(run.period) }]}
        title={`Depreciation, ${monthLabel(run.period)}`}
        meta={<>
          <StateBadge kind="run" value={run.status} />
          {run.status !== "draft" && <span className="num text-base font-semibold">{money(run.total_amount)}</span>}
          {run.status !== "draft" && <span className="text-muted-foreground">{run.asset_count} {run.asset_count === 1 ? "asset" : "assets"}</span>}
        </>}
        actions={<>
          {run.status === "draft" && can("assets.depreciation_run.post") && (
            <Button size="lg" onClick={() => post.mutate()} disabled={post.isPending || preview.data?.length === 0}><BookCheck aria-hidden /> Post run</Button>
          )}
          {run.status === "posted" && can("assets.depreciation_run.cancel") && (
            <ActionDialog open={reverseOpen} onOpenChange={setReverseOpen} trigger={<Button variant="outline"><Undo2 aria-hidden /> Reverse</Button>}
              title={`Reverse ${monthLabel(run.period)}`} description="Posts a reversing journal and restores the assets' book values. Later months must be reversed first."
              submitLabel="Reverse run" destructive pending={reverse.isPending} error={reverse.error} disabled={!reason.trim()} onSubmit={() => reverse.mutate()}>
              <Field id="rev-reason" label="Reason"><Input id="rev-reason" className="h-10" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <Field id="rev-date" label="Reversal date" hint="Date of the reversing journal."><Input id="rev-date" type="date" className="h-10" value={reversalDate} onChange={(e) => setReversalDate(e.target.value)} /></Field>
            </ActionDialog>
          )}
        </>}
      />
      {post.error && <div className="mb-4"><FormError message={problemMessage(post.error)} /></div>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
        <Section title={run.status === "draft" ? "Preview" : "Entries"} description={run.status === "draft" ? "What posting would charge now. Posting needs a fresh two-step verification." : "Per-asset depreciation as posted."}>
          {run.status === "draft" && preview.isLoading ? <RowsSkeleton rows={3} /> : preview.error ? <ErrorState error={preview.error} /> : lines.length === 0
            ? <EmptyState title="Nothing to depreciate" description="No capitalized asset is due for depreciation in this month." />
            : <Lines lines={lines} />}
        </Section>
        <Section title="Run">
          <Facts items={[
            ["Created", `${dateTime(run.created_at)} by ${person(run.created_by)}`],
            run.posted_at && ["Posted", `${dateTime(run.posted_at)} by ${person(run.posted_by)}`],
            run.reversed_at && ["Reversed", `${dateTime(run.reversed_at)} by ${person(run.reversed_by)}`],
            run.reversal_reason && ["Reason", run.reversal_reason],
          ]} />
        </Section>
      </div>
    </>
  );
}
