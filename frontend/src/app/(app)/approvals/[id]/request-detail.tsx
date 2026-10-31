"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, Check, Undo2, X } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ApprovalStatus } from "@/components/erp/status";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { dateTime, money } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

type Step = components["schemas"]["Step"];

const DENIAL_COPY: Record<string, string> = {
  permission_denied: "You can't decide this step. It may need a higher approval limit or a different role.",
};

function StepRow({ step, current }: { step: Step; current: boolean }) {
  return (
    <li className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-3 pb-6 last:pb-0">
      <span aria-hidden className="absolute top-8 bottom-0 left-[0.95rem] w-px bg-border last:hidden" />
      <span
        className={cn(
          "num z-10 grid size-8 place-items-center rounded-full border text-sm font-semibold",
          step.status === "approved" && "border-status-approved bg-status-approved text-white",
          step.status === "rejected" && "border-status-rejected bg-status-rejected text-white",
          step.status === "pending" && current && "border-foreground bg-primary text-primary-foreground",
          step.status === "pending" && !current && "bg-card text-muted-foreground",
          step.status === "skipped" && "bg-muted text-muted-foreground",
        )}
      >
        {step.status === "approved" ? <Check className="size-4" /> : step.status === "rejected" ? <X className="size-4" /> : step.sequence}
      </span>
      <div className="min-w-0 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{step.name}</p>
          <ApprovalStatus status={step.status} />
          {step.is_final && <span className="text-xs text-muted-foreground">final approval</span>}
        </div>
        <p className="text-sm text-muted-foreground">Approver role: {step.role_name}</p>
        {step.decided_by && (
          <p className="mt-1 text-sm">
            {step.status === "approved" ? "Approved" : "Rejected"} by {step.decided_by.full_name}
            {step.acting_for && <> on behalf of {step.acting_for.full_name}</>}, {dateTime(step.decided_at)}
          </p>
        )}
        {step.comment && <blockquote className="mt-2 border-l-2 pl-3 text-sm">{step.comment}</blockquote>}
        {step.status === "pending" && step.due_at && (
          <p className={cn("mt-1 flex items-center gap-1.5 text-sm", step.escalated_at ? "text-status-pending" : "text-muted-foreground")}>
            <AlarmClock className="size-3.5" aria-hidden />
            {step.escalated_at ? `Overdue since ${dateTime(step.due_at)}, escalated` : `Due ${dateTime(step.due_at)}`}
          </p>
        )}
      </div>
    </li>
  );
}

export function RequestDetail() {
  const { id } = useParams<{ id: string }>();
  const { me } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const query = useQuery({
    queryKey: ["approvals", "request", id],
    queryFn: () => unwrap(api.GET("/api/v1/approvals/requests/{id}/", { params: { path: { id } } })),
  });

  const decide = useMutation({
    mutationFn: async (verb: "approve" | "reject") => {
      const key = idempotencyKey(); // same key if the step-up dialog makes us retry
      const body = { comment, version: query.data!.version };
      return withStepUp(() =>
        unwrap(
          verb === "approve"
            ? api.POST("/api/v1/approvals/requests/{id}/approve/", { params: { path: { id }, header: { "Idempotency-Key": key } }, body })
            : api.POST("/api/v1/approvals/requests/{id}/reject/", { params: { path: { id }, header: { "Idempotency-Key": key } }, body }),
        ),
      );
    },
    onSuccess: (data, verb) => {
      queryClient.setQueryData(["approvals", "request", id], data);
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      setComment("");
      toast(verb === "approve" ? "Approved" : "Rejected");
    },
  });

  const withdraw = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/api/v1/approvals/requests/{id}/withdraw/", {
        params: { path: { id } }, body: { comment, version: query.data!.version },
      })),
    onSuccess: (data) => {
      queryClient.setQueryData(["approvals", "request", id], data);
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      toast("Request withdrawn");
    },
  });

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const r = query.data!;
  const mine = r.requested_by.id === me.user.id;
  const error = decide.error ?? withdraw.error;
  const errorMessage = !error ? undefined : isApiError(error, "version_conflict")
    ? "Someone acted on this request while you were reading it. The latest state is shown below."
    : isApiError(error) ? DENIAL_COPY[error.type] ?? error.summary() : "Couldn't reach the server.";

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Approvals", href: "/approvals" }, { label: `${r.document_label} ${r.document_number}`.trim() }]}
        title={r.title}
        meta={
          <>
            <ApprovalStatus status={r.status} />
            <span className="num text-base font-semibold">{money(r.amount, r.currency || "INR")}</span>
            <span className="text-muted-foreground">Requested by {r.requested_by.full_name} on {dateTime(r.submitted_at)}</span>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Section title="Approval route" description={`${r.steps.length} step${r.steps.length === 1 ? "" : "s"}, decided in order.`}>
          <ol className="px-5 py-5">
            {r.steps.map((step) => <StepRow key={step.id} step={step} current={step.sequence === r.current_sequence} />)}
          </ol>
        </Section>

        <div className="grid content-start gap-6">
          {r.can_decide && r.status === "pending" && (
            <Section title="Your decision" description="Approving moves the request to the next step, or completes it at the final step.">
              <form className="grid gap-4 px-5 py-4" onSubmit={(e) => e.preventDefault()}>
                <FormError message={errorMessage} />
                <Field id="comment" label="Comment" hint="Required when you reject. Visible to the requester and later approvers.">
                  <Textarea id="comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => decide.mutate("approve")} disabled={decide.isPending}>
                    <Check aria-hidden /> Approve
                  </Button>
                  <Button variant="outline" className="border-status-rejected/40 text-status-rejected hover:bg-status-rejected/10"
                    onClick={() => decide.mutate("reject")} disabled={decide.isPending || !comment.trim()}>
                    <X aria-hidden /> Reject
                  </Button>
                </div>
              </form>
            </Section>
          )}

          {mine && r.status === "pending" && (
            <Section title="Withdraw request" description="Stops the approval. You can submit the document again later.">
              <div className="px-5 py-4">
                {!r.can_decide && <FormError message={errorMessage} />}
                <Button variant="outline" onClick={() => withdraw.mutate()} disabled={withdraw.isPending}>
                  <Undo2 aria-hidden /> Withdraw
                </Button>
              </div>
            </Section>
          )}

          <Section title="Details">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 px-5 py-4 text-sm">
              <dt className="text-muted-foreground">Document</dt><dd>{r.document_label}</dd>
              <dt className="text-muted-foreground">Number</dt><dd className="num">{r.document_number || "—"}</dd>
              {Object.entries(r.summary ?? {}).map(([key, value]) => (
                <span key={key} className="contents">
                  <dt className="text-muted-foreground">{(key.charAt(0).toUpperCase() + key.slice(1)).replace(/_/g, " ")}</dt><dd>{String(value)}</dd>
                </span>
              ))}
              {r.completed_at && <><dt className="text-muted-foreground">Completed</dt><dd>{dateTime(r.completed_at)}</dd></>}
            </dl>
          </Section>
        </div>
      </div>
    </>
  );
}
