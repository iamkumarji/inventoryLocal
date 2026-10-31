"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, BookOpen, Check, Send, Stamp } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { ActionError, Facts, NextStep, Who } from "@/components/inventory/bits";
import { bannerError, fieldErrors } from "@/components/inventory/problem";
import { signedQty } from "@/components/inventory/decimal";
import { InvStatus } from "@/components/inventory/status";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { ADJUSTMENT_REASONS, useLocations, useWarehouses, type Adjustment } from "@/lib/api/inventory";
import { date, dateTime, money } from "@/lib/format";
import { useSession } from "@/lib/session";

type Verb = "submit" | "approve" | "post";
type Line = Adjustment["lines"][number];

const DENIED: Record<Verb, string> = {
  submit: "You can't submit adjustments for this warehouse.",
  approve: "You can't approve adjustments for this warehouse.",
  post: "You can't post adjustments for this warehouse.",
};

function CancelDialog({ adjustment, open, onOpenChange, onCancelled }: {
  adjustment: Adjustment; open: boolean; onOpenChange: (o: boolean) => void; onCancelled: (a: Adjustment) => void;
}) {
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/inventory/adjustments/{id}/cancel/", {
      params: { path: { id: adjustment.id } }, body: { reason: reason.trim(), version: adjustment.version },
    })),
    onSuccess: (a) => { onCancelled(a); onOpenChange(false); setReason(""); },
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setLocalError(null); cancel.reset(); } }}>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => {
          e.preventDefault();
          const problem = reason.trim() ? null : "Say why the adjustment is cancelled.";
          setLocalError(problem);
          if (!problem) cancel.mutate();
        }}>
          <DialogHeader>
            <DialogTitle>Cancel this adjustment?</DialogTitle>
            <DialogDescription>Nothing was posted, so no stock changes. The adjustment stays on record as cancelled.</DialogDescription>
          </DialogHeader>
          <Field id="adj-cancel-reason" label="Reason" error={fieldErrors(cancel.error).reason}>
            <Textarea id="adj-cancel-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Entered in error, duplicate…" />
          </Field>
          {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
          <ActionError error={bannerError(cancel.error)} denied="You can't cancel adjustments for this warehouse." />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Keep it</Button>
            <Button type="submit" variant="destructive" disabled={cancel.isPending}>Cancel adjustment</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AdjustmentDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const wh = useWarehouses({ activeCompanyOnly: false });
  const key = ["inventory", "adjustment", id];
  const query = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/api/v1/inventory/adjustments/{id}/", { params: { path: { id } } })) });
  const locations = useLocations(query.data?.warehouse, can("inventory.location.read"));
  const [cancelling, setCancelling] = useState(false);
  const locationCode = (loc: string | null | undefined) => (loc ? locations.data?.results.find((l) => l.id === loc)?.code ?? "Bin" : "—");

  const act = useMutation({
    mutationFn: (verb: Verb) => {
      const doc = query.data!;
      const body = { version: doc.version };
      const path = { id };
      if (verb === "submit") return unwrap(api.POST("/api/v1/inventory/adjustments/{id}/submit/", { params: { path }, body }));
      if (verb === "approve") return withStepUp(() => unwrap(api.POST("/api/v1/inventory/adjustments/{id}/approve/", { params: { path }, body })));
      const idem = idempotencyKey();
      return unwrap(api.POST("/api/v1/inventory/adjustments/{id}/post/", { params: { path, header: { "Idempotency-Key": idem } }, body }));
    },
    onSuccess: (doc, verb) => {
      queryClient.setQueryData(key, doc);
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      toast(verb === "submit" ? "Submitted for approval" : verb === "approve" ? "Adjustment approved" : `Posted as ${doc.number}`);
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict") || isApiError(error, "invalid_state_transition")) query.refetch();
    },
  });

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const a = query.data!;
  const routeActive = isApiError(act.error) && act.error.problem.code === "approval_route_active";

  const columns: Column<Line>[] = [
    { key: "item", header: "Item", cell: (l) => <span className="num font-medium">{l.item_code}</span> },
    { key: "qty", header: "Quantity", align: "right", cell: (l) => <span className={`num font-medium ${l.quantity.startsWith("-") ? "text-status-rejected" : "text-status-approved"}`}>{signedQty(l.quantity)}</span> },
    { key: "cost", header: "Unit cost", align: "right", cell: (l) => <span className="num">{l.unit_cost ? money(l.unit_cost) : <span className="text-muted-foreground">Average</span>}</span> },
    { key: "batch", header: "Batch", cell: (l) => <span className="num">{l.batch_number || "—"}{l.expires_on ? <span className="block text-xs text-muted-foreground">exp. {date(l.expires_on)}</span> : null}</span> },
    { key: "serials", header: "Serials", cell: (l) => { const s = (l.serials as string[] | undefined) ?? []; return <span className="num text-xs">{s.length ? s.join(", ") : "—"}</span>; } },
    { key: "bin", header: "Bin", cell: (l) => <span className="num">{locationCode(l.location)}</span> },
  ];

  const next = (() => {
    if (a.status === "draft" || a.status === "rejected") {
      return can("inventory.stock_adjustment.update") ? (
        <NextStep title={a.status === "rejected" ? "Rejected: correct and resubmit" : "Submit for approval"}
          body="Submitting values the adjustment at current cost and sends it to an approver. If your company has an approval route for adjustments, it appears in their Approvals inbox.">
          <Button onClick={() => act.mutate("submit")} disabled={act.isPending}><Send aria-hidden /> Submit for approval</Button>
          <Button variant="outline" onClick={() => setCancelling(true)} disabled={act.isPending}><Ban aria-hidden /> Cancel adjustment</Button>
        </NextStep>
      ) : <NextStep title="Draft" body="Someone with permission to update adjustments needs to submit it." />;
    }
    if (a.status === "submitted") {
      return can("inventory.stock_adjustment.approve") ? (
        <NextStep title="Waiting for approval" body="Approve to allow posting. The person who created or submitted the adjustment can't approve it.">
          <Button onClick={() => act.mutate("approve")} disabled={act.isPending}><Check aria-hidden /> Approve</Button>
          {routeActive && <Button variant="outline" asChild><Link href="/approvals">Open Approvals</Link></Button>}
        </NextStep>
      ) : <NextStep title="Waiting for approval" body="An approver needs to approve this adjustment before it can be posted." />;
    }
    if (a.status === "approved") {
      return can("inventory.stock_adjustment.post") ? (
        <NextStep title="Approved: ready to post" body="Posting moves the stock, writes the ledger and the matching accounting entry. It can't be undone; correct mistakes with another adjustment.">
          <Button onClick={() => act.mutate("post")} disabled={act.isPending}><Stamp aria-hidden /> Post to stock</Button>
        </NextStep>
      ) : <NextStep title="Approved" body="Someone with permission to post adjustments needs to post it." />;
    }
    if (a.status === "cancelled") return <NextStep title="Cancelled" body="This adjustment was withdrawn before posting. Stock didn't change." />;
    return null;
  })();

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Adjustments", href: "/inventory/adjustments" }, { label: a.number || "Unposted" }]}
        title={a.number ? <span className="num">{a.number}</span> : "Unposted adjustment"}
        meta={<>
          <InvStatus kind="doc" status={a.status} />
          <span>{ADJUSTMENT_REASONS[a.reason] ?? a.reason}</span>
          <span className="num text-muted-foreground">{wh.label(a.warehouse)}</span>
          {a.status !== "draft" && <span className="num font-semibold">{money(a.amount, a.currency || "INR")}</span>}
        </>}
        actions={a.status === "posted" && can("inventory.stock_ledger.read") && (
          <Button variant="outline" asChild><Link href={`/inventory/ledger?source_id=${a.id}`}><BookOpen aria-hidden /> Ledger entries</Link></Button>
        )}
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6">
          {next && (
            <Section>
              <div className="grid gap-3 px-5 py-4">
                {next}
                <ActionError error={act.error} denied={act.variables ? DENIED[act.variables] : undefined} />
              </div>
            </Section>
          )}
          {a.status !== "posted" && a.status !== "cancelled" && can("inventory.stock_adjustment.update") && (
            <CancelDialog adjustment={a} open={cancelling} onOpenChange={setCancelling} onCancelled={(doc) => {
              queryClient.setQueryData(key, doc);
              queryClient.invalidateQueries({ queryKey: ["inventory", "adjustments"] });
              toast("Adjustment cancelled");
            }} />
          )}
          <Section title="Lines" description="Positive quantities add stock, negative remove it.">
            <DataTable columns={columns} rows={a.lines} caption="Adjustment lines" />
          </Section>
        </div>
        <Section title="Details" className="min-w-0 content-start self-start">
          <div className="px-5 py-4">
            <Facts items={[
              ["Posting date", date(a.posting_date)],
              ["Warehouse", <span key="w" className="num">{wh.label(a.warehouse)}</span>],
              ["Created by", <Who key="c" id={a.created_by} />],
              ["Created", dateTime(a.created_at)],
              ["Submitted by", <Who key="s" id={a.submitted_by} />],
              ["Approved by", <Who key="a" id={a.approved_by} />],
              a.notes ? ["Notes", a.notes] : null,
            ]} />
          </div>
        </Section>
      </div>
    </>
  );
}

