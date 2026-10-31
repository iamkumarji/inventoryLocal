"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Send, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError } from "@/components/finance/action-error";
import { Side } from "@/components/finance/amount";
import { DocStatus } from "@/components/finance/controls";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { type JournalEntry, sumDecimals, today, useCostCenters } from "@/lib/api/finance";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

import { sourceLabel } from "../journals-view";

function ReverseDialog({ entry, onDone }: { entry: JournalEntry; onDone: (reversal: JournalEntry) => void }) {
  const { withStepUp } = useStepUp();
  const [open, setOpen] = useState(false);
  const [reversalDate, setReversalDate] = useState(today());
  const [reason, setReason] = useState("");
  const reverse = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/finance/journal-entries/{id}/reverse/", {
      params: { path: { id: entry.id } }, body: { reversal_date: reversalDate, reason: reason.trim() },
    }))),
    onSuccess: (reversal) => { setOpen(false); onDone(reversal); },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline"><Undo2 aria-hidden /> Reverse</Button></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); reverse.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Reverse {entry.number}?</DialogTitle>
            <DialogDescription>
              A new entry with every debit and credit swapped is posted on the date you choose. {entry.number} itself stays unchanged in the ledger.
            </DialogDescription>
          </DialogHeader>
          <Field id="reversal_date" label="Reversal date"><Input id="reversal_date" type="date" value={reversalDate} onChange={(e) => setReversalDate(e.target.value)} required /></Field>
          <Field id="reversal_reason" label="Reason" hint="Recorded on the reversal and in the audit log.">
            <Textarea id="reversal_reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required rows={2} />
          </Field>
          <ActionError error={reverse.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!reason.trim() || reverse.isPending}>Post reversal</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function JournalDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { withStepUp } = useStepUp();
  const costCenters = useCostCenters();
  const q = useQuery({
    queryKey: ["finance", "journal", id],
    queryFn: () => unwrap(api.GET("/api/v1/finance/journal-entries/{id}/", { params: { path: { id } } })),
  });
  const key = useRef<string | null>(null);
  const post = useMutation({
    mutationFn: (entry: JournalEntry) => {
      key.current ??= idempotencyKey(); // the same key covers a retry after step-up verification
      return withStepUp(() => unwrap(api.POST("/api/v1/finance/journal-entries/{id}/post/", {
        params: { path: { id: entry.id }, header: { "Idempotency-Key": key.current! } },
        body: { version: entry.version },
      })));
    },
    onSuccess: (entry) => {
      key.current = null;
      queryClient.setQueryData(["finance", "journal", id], entry);
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast(`Posted as ${entry.number}`);
    },
    onError: (error) => {
      key.current = null;
      if (isApiError(error) && error.status === 409) queryClient.invalidateQueries({ queryKey: ["finance", "journal", id] });
    },
  });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const e = q.data!;
  const ccName = (ccId: string | null) => costCenters.data?.results.find((c) => c.id === ccId)?.code ?? "";
  const mine = e.created_by === me.user.id;
  const canPost = e.status === "draft" && can("finance.journal_entry.post");
  const canReverse = e.status === "posted" && !e.reversed_by && !e.is_reversal && can("finance.journal_entry.cancel");
  const totalDebit = sumDecimals(e.lines.map((l) => l.debit));
  const totalCredit = sumDecimals(e.lines.map((l) => l.credit));

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Journals", href: "/finance/journals" }, { label: e.number || "Draft" }]}
        title={e.number ? `Journal ${e.number}` : "Draft journal"}
        description={e.narration}
        meta={<>
          <DocStatus status={e.status} />
          {e.reversed_by && <StatusBadge tone="neutral">Reversed</StatusBadge>}
          {e.is_reversal && <StatusBadge tone="info">Reversal</StatusBadge>}
          <span className="text-muted-foreground">{date(e.entry_date)}</span>
          <span className="text-muted-foreground">{sourceLabel(e)}</span>
          {e.posted_at && <span className="text-muted-foreground">Posted {dateTime(e.posted_at)}{e.posted_by === me.user.id ? " by you" : ""}</span>}
        </>}
        actions={<>
          {canPost && <Button onClick={() => post.mutate(e)} disabled={post.isPending}><Send aria-hidden /> Post</Button>}
          {canReverse && <ReverseDialog entry={e} onDone={(reversal) => {
            queryClient.invalidateQueries({ queryKey: ["finance"] });
            toast(`Reversal ${reversal.number} posted`);
            router.push(`/finance/journals/${reversal.id}`);
          }} />}
        </>}
      />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
        {e.status === "draft" && mine && (
          <p className="flex items-start gap-2 rounded-md border border-status-info/30 bg-status-info/10 px-3 py-2.5 text-sm text-status-info">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
            You prepared this journal, so another person posts it{can("finance.journal_entry.self_approve") ? " (or you, with your self-approval right and a fresh verification)" : ""}.
          </p>
        )}
        {e.status === "posted" && (
          <p className="text-sm text-muted-foreground">
            Posted entries can&apos;t be edited.{" "}
            {e.reversed_by && <>Reversed by <Link className="font-medium text-foreground underline underline-offset-4" href={`/finance/journals/${e.reversed_by}`}>the reversal entry</Link>.</>}
            {e.reverses && <>This entry reverses <Link className="font-medium text-foreground underline underline-offset-4" href={`/finance/journals/${e.reverses}`}>the original entry</Link>.</>}
          </p>
        )}
        <ActionError error={post.error} forbidden="You can't post this journal. The person who prepared it can't post it; a second person with posting rights must." />
        <Section title="Lines">
          <LedgerTable caption="Journal lines" columns={[
            { key: "no", header: "#" }, { key: "account", header: "Account" }, { key: "desc", header: "Description" },
            { key: "partner", header: "Partner" }, { key: "cc", header: "Cost centre" },
            { key: "debit", header: "Debit", align: "right" }, { key: "credit", header: "Credit", align: "right" },
          ]} footer={
            <Row className="hover:bg-transparent">
              <Cell colSpan={5} className="font-semibold">Total</Cell>
              <Cell align="right" className="font-semibold"><Side value={totalDebit} /></Cell>
              <Cell align="right" className="font-semibold"><Side value={totalCredit} /></Cell>
            </Row>
          }>
            {e.lines.map((l) => (
              <Row key={l.line_no}>
                <Cell className="text-muted-foreground">{l.line_no}</Cell>
                <Cell className="min-w-48"><span className="mr-2 text-muted-foreground">{l.account_code}</span><span className="font-sans">{l.account_name}</span></Cell>
                <Cell className="font-sans text-muted-foreground">{l.description}</Cell>
                <Cell className="font-sans">{l.partner_name ?? ""}</Cell>
                <Cell>{ccName(l.cost_center)}</Cell>
                <Cell align="right"><Side value={l.debit} /></Cell>
                <Cell align="right"><Side value={l.credit} /></Cell>
              </Row>
            ))}
          </LedgerTable>
        </Section>
      </div>
    </>
  );
}
