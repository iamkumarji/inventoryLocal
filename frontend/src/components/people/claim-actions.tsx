"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { toast } from "sonner";

import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { compareDecimal, errorText, rowErrors, useMyEmployee, type Advance, type Claim } from "@/lib/api/people";
import { useSession } from "@/lib/session";

import { DecideDialog, PayDialog, RowErrorList } from "./actions";
import { Amount } from "./amount";

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["people"] });
}

/** True when the signed-in user filed, submitted or is the employee on the document. */
export function useIsMaker(doc: { employee?: string; created_by: string | null; submitted_by: string | null }) {
  const { me } = useSession();
  const mine = useMyEmployee();
  return doc.created_by === me.user.id || doc.submitted_by === me.user.id || Boolean(mine.data && doc.employee === mine.data.id);
}

export function SubmitClaim({ claim, size = "sm" }: { claim: Claim; size?: "sm" | "lg" }) {
  const refresh = useRefresh();
  const submit = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/expenses/claims/{id}/submit/", { params: { path: { id: claim.id } }, body: { version: claim.version } })),
    onSuccess: () => { refresh(); toast(`Claim ${claim.number} submitted for approval`); },
    onError: (error) => { if (isApiError(error, "version_conflict")) refresh(); },
  });
  const lines = rowErrors(submit.error);
  return (
    <div className="grid gap-2">
      <Button size={size} disabled={submit.isPending} onClick={() => submit.mutate()}><Send aria-hidden /> Submit for approval</Button>
      {submit.error && (
        lines.length > 0
          ? <div className="grid gap-1.5"><p role="alert" className="text-sm font-medium text-status-rejected">{errorText(submit.error)}</p><RowErrorList errors={lines} unit="Line" /></div>
          : <p role="alert" className="text-sm text-status-rejected">{errorText(submit.error)}</p>
      )}
    </div>
  );
}

export function DecideClaim({ claim }: { claim: Claim }) {
  const refresh = useRefresh();
  const maker = useIsMaker(claim);
  const decide = useMutation({
    mutationFn: ({ approve, comment }: { approve: boolean; comment: string }) =>
      unwrap(api.POST("/api/v1/expenses/claims/{id}/decide/", { params: { path: { id: claim.id } }, body: { approve, comment, version: claim.version } })),
    onSuccess: (c) => { refresh(); toast(c.status === "approved" ? `Claim ${c.number} approved and posted` : `Claim ${c.number} rejected`); },
    onError: (error) => { if (isApiError(error, "version_conflict")) refresh(); },
  });
  return (
    <DecideDialog title={`Claim ${claim.number}`} description={<>{claim.employee_name} · <Amount value={claim.amount} currency={claim.currency} /> · {claim.purpose}</>}
      blockedReason={maker ? "This is your own claim (or you filed it). Someone else must decide it." : undefined}
      pending={decide.isPending} error={decide.error} onDecide={(approve, comment) => decide.mutateAsync({ approve, comment })} />
  );
}

export function PayClaim({ claim }: { claim: Claim }) {
  const refresh = useRefresh();
  const { withStepUp } = useStepUp();
  const maker = useIsMaker(claim);
  const pay = useMutation({
    mutationFn: ({ body, key }: { body: { paid_on: string; bank_reference: string }; key: string }) => withStepUp(() =>
      unwrap(api.POST("/api/v1/expenses/claims/{id}/pay/", {
        params: { path: { id: claim.id }, header: { "Idempotency-Key": key } },
        body: { ...body, version: claim.version },
      }))),
    onSuccess: (c) => { refresh(); toast(`Claim ${c.number} marked paid`); },
    onError: (error) => { if (isApiError(error, "version_conflict")) refresh(); },
  });
  return (
    <PayDialog title={`Reimburse claim ${claim.number}`} description={<>Pay <Amount value={claim.net_payable} currency={claim.currency} /> to {claim.employee_name}{compareDecimal(claim.advance_settled, "0") > 0 ? " (net of the advance settled)" : ""}.</>}
      blockedReason={maker ? "You can't pay a claim you filed, submitted or are the claimant on." : undefined}
      pending={pay.isPending} error={pay.error} onPay={(body, key) => pay.mutateAsync({ body, key })} />
  );
}

export function DecideAdvance({ advance }: { advance: Advance }) {
  const refresh = useRefresh();
  const maker = useIsMaker(advance);
  const decide = useMutation({
    mutationFn: ({ approve, comment }: { approve: boolean; comment: string }) =>
      unwrap(api.POST("/api/v1/expenses/advances/{id}/decide/", { params: { path: { id: advance.id } }, body: { approve, comment, version: advance.version } })),
    onSuccess: (a) => { refresh(); toast(a.status === "approved" ? `Advance ${a.number} approved` : `Advance ${a.number} rejected`); },
    onError: (error) => { if (isApiError(error, "version_conflict")) refresh(); },
  });
  return (
    <DecideDialog title={`Advance ${advance.number}`} description={<>{advance.employee_name} · <Amount value={advance.amount} currency={advance.currency} /> · {advance.purpose}</>}
      blockedReason={maker ? "This is your own advance (or you requested it). Someone else must decide it." : undefined}
      pending={decide.isPending} error={decide.error} onDecide={(approve, comment) => decide.mutateAsync({ approve, comment })} />
  );
}

export function PayAdvance({ advance }: { advance: Advance }) {
  const refresh = useRefresh();
  const { withStepUp } = useStepUp();
  const maker = useIsMaker(advance);
  const pay = useMutation({
    mutationFn: ({ body, key }: { body: { paid_on: string; bank_reference: string }; key: string }) => withStepUp(() =>
      unwrap(api.POST("/api/v1/expenses/advances/{id}/pay/", {
        params: { path: { id: advance.id }, header: { "Idempotency-Key": key } },
        body: { ...body, version: advance.version },
      }))),
    onSuccess: (a) => { refresh(); toast(`Advance ${a.number} paid`); },
    onError: (error) => { if (isApiError(error, "version_conflict")) refresh(); },
  });
  return (
    <PayDialog title={`Pay advance ${advance.number}`} description={<>Pay <Amount value={advance.amount} currency={advance.currency} /> to {advance.employee_name}.</>}
      blockedReason={maker ? "You can't pay an advance you requested or are the employee on." : undefined}
      pending={pay.isPending} error={pay.error} onPay={(body, key) => pay.mutateAsync({ body, key })} />
  );
}

/** Actions available on a claim for the current user, in workflow order. */
export function ClaimActions({ claim }: { claim: Claim }) {
  const { can } = useSession();
  return (
    <>
      {(claim.status === "draft" || claim.status === "rejected") && can("expenses.expense_claim.update") && <SubmitClaim claim={claim} />}
      {claim.status === "submitted" && (can("expenses.expense_claim.approve") || can("expenses.expense_claim.reject")) && <DecideClaim claim={claim} />}
      {claim.status === "approved" && can("expenses.expense_claim.pay") && <PayClaim claim={claim} />}
    </>
  );
}

export function AdvanceActions({ advance }: { advance: Advance }) {
  const { can } = useSession();
  return (
    <>
      {advance.status === "requested" && (can("expenses.employee_advance.approve") || can("expenses.employee_advance.reject")) && <DecideAdvance advance={advance} />}
      {advance.status === "approved" && can("expenses.employee_advance.pay") && <PayAdvance advance={advance} />}
    </>
  );
}
