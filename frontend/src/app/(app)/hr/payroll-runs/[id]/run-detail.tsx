"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookCheck, Calculator, Send } from "lucide-react";
import { useParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { DecideDialog, Facts } from "@/components/people/actions";
import { Amount, DocStatus } from "@/components/people/amount";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { SENSITIVE_QUERY, errorText, periodLabel, type PayrollRun } from "@/lib/api/people";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

import { PayslipTable } from "../../payroll/payslips-tab";

const KEY = (id: string) => ["people", "payroll-run", id];

function useRunMutation<T>(id: string, fn: (vars: T) => Promise<PayrollRun>, done: (run: PayrollRun) => string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (run) => {
      queryClient.setQueryData(KEY(id), run);
      queryClient.invalidateQueries({ queryKey: ["people", "payslips"] });
      queryClient.invalidateQueries({ queryKey: ["people", "payroll-runs"] });
      toast(done(run));
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: KEY(id) });
    },
  });
}

function PostRun({ run }: { run: PayrollRun }) {
  const { withStepUp } = useStepUp();
  const [open, setOpen] = useState(false);
  const [postingDate, setPostingDate] = useState(run.period_end);
  const [key, setKey] = useState(idempotencyKey);
  const post = useRunMutation(run.id, () => withStepUp(() => unwrap(api.POST("/api/v1/hr/payroll-runs/{id}/post/", {
    params: { path: { id: run.id }, header: { "Idempotency-Key": key } },
    body: { posting_date: postingDate, version: run.version },
  }))), (r) => `Payroll ${r.number} posted to the ledger`);
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) { setKey(idempotencyKey()); post.reset(); } }}>
      <DialogTrigger asChild><Button size="sm"><BookCheck aria-hidden /> Post to ledger</Button></DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <form className="grid gap-4" onSubmit={async (e) => { e.preventDefault(); try { await post.mutateAsync(undefined); setOpen(false); } catch { /* shown */ } }}>
          <DialogHeader>
            <DialogTitle>Post payroll {run.number}?</DialogTitle>
            <DialogDescription>One balanced journal: salary expense and employer contributions, against net pay and statutory dues. Employees can then see their payslips.</DialogDescription>
          </DialogHeader>
          <FormError message={post.error ? errorText(post.error) : undefined} />
          <Field id="posting-date" label="Posting date"><Input id="posting-date" type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} required /></Field>
          <DialogFooter><Button type="submit" disabled={post.isPending}>Post payroll</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RunActions({ run }: { run: PayrollRun }) {
  const { can, me } = useSession();
  const { withStepUp } = useStepUp();
  const compute = useRunMutation(run.id, () => unwrap(api.POST("/api/v1/hr/payroll-runs/{id}/compute/", { params: { path: { id: run.id } }, body: { version: run.version } })),
    (r) => `Computed ${r.employee_count} payslip(s)`);
  const submit = useRunMutation(run.id, () => unwrap(api.POST("/api/v1/hr/payroll-runs/{id}/submit/", { params: { path: { id: run.id } }, body: { version: run.version } })),
    () => "Sent for approval");
  const decide = useRunMutation(run.id, ({ approve, comment }: { approve: boolean; comment: string }) => withStepUp(() => unwrap(api.POST("/api/v1/hr/payroll-runs/{id}/decide/", {
    params: { path: { id: run.id } }, body: { approve, comment, version: run.version },
  }))), (r) => (r.status === "approved" ? "Payroll approved" : "Payroll rejected; it can be recomputed"));
  const maker = run.submitted_by === me.user.id || run.created_by === me.user.id;
  const buttons: ReactNode[] = [];
  if (["draft", "computed", "rejected"].includes(run.status) && can("hr.payroll_run.update")) {
    buttons.push(
      <Button key="compute" size="sm" variant={run.status === "computed" ? "outline" : "default"} disabled={compute.isPending} onClick={() => compute.mutate(undefined, { onError: (e) => toast.error(errorText(e)) })}>
        <Calculator aria-hidden /> {run.status === "draft" ? "Compute" : "Recompute"}
      </Button>,
    );
  }
  if (run.status === "computed" && can("hr.payroll_run.update")) {
    buttons.push(
      <Button key="submit" size="sm" disabled={submit.isPending} onClick={() => submit.mutate(undefined, { onError: (e) => toast.error(errorText(e)) })}>
        <Send aria-hidden /> Submit for approval
      </Button>,
    );
  }
  if (run.status === "submitted" && (can("hr.payroll_run.approve") || can("hr.payroll_run.reject"))) {
    buttons.push(
      <DecideDialog key="decide" title={`Payroll ${run.number}`} triggerLabel="Decide"
        description={`${periodLabel(run.year, run.month)} · ${run.employee_count} employee(s)`}
        blockedReason={maker ? "You prepared this payroll, so someone else must approve it." : undefined}
        pending={decide.isPending} error={decide.error} onDecide={(approve, comment) => decide.mutateAsync({ approve, comment })} />,
    );
  }
  if (run.status === "approved" && can("hr.payroll_run.post")) buttons.push(<PostRun key="post" run={run} />);
  return <>{buttons}</>;
}

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const run = useQuery({
    queryKey: KEY(id),
    queryFn: () => unwrap(api.GET("/api/v1/hr/payroll-runs/{id}/", { params: { path: { id } } })) as Promise<PayrollRun>,
    ...SENSITIVE_QUERY,
  });
  if (run.isLoading) return <PageSkeleton />;
  if (run.error) return <ErrorState error={run.error} onRetry={run.refetch} />;
  const r = run.data!;
  const totals = (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-b-lg bg-border sm:grid-cols-5">
      {([
        ["Gross pay", r.gross_total],
        ["Deductions", r.deduction_total],
        ["Net pay", r.net_total],
        ["Employer contributions", r.employer_total],
        ["Total cost", r.amount],
      ] as const).map(([label, value]) => (
        <div key={label} className="bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-base font-semibold"><Amount value={value} currency={r.currency} /></p>
        </div>
      ))}
    </div>
  );
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Payroll", href: "/hr/payroll" }, { label: r.number || "Run" }]}
        title={`Payroll ${periodLabel(r.year, r.month)}`}
        meta={<><DocStatus status={r.status} /><span className="text-muted-foreground">{r.number}</span><span className="text-muted-foreground">{date(r.period_start)} – {date(r.period_end)}</span></>}
        actions={<RunActions run={r} />}
      />
      <div className="grid gap-6">
        <Section title="Totals" description={r.amount === undefined ? "Amounts are restricted to people who can read salaries." : `${r.employee_count} employee(s)`}>
          {totals}
        </Section>
        <div className={`grid gap-6 ${can("hr.payslip.read") ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" : "max-w-xl"}`}>
          {can("hr.payslip.read") && <Section title="Payslips"><PayslipTable run={r.id} /></Section>}
          <Section title="History">
            <Facts items={[
              ["Employees", <span key="c" className="num">{r.employee_count}</span>],
              ["Computed", r.computed_at ? dateTime(r.computed_at) : "Not yet"],
              ["Posted", r.posted_at ? dateTime(r.posted_at) : "—"],
              ["Posting date", r.posting_date ? date(r.posting_date) : "—"],
              ["Journal", r.journal_entry ? "Posted" : "—"],
            ]} />
          </Section>
        </div>
      </div>
    </>
  );
}
