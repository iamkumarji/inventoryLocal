"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/erp/field";
import { ErrorState, RowsSkeleton } from "@/components/erp/states";
import { RowErrorList } from "@/components/people/actions";
import { ClaimLinesEditor, blankLine, lineToApi, type LineDraft } from "@/components/people/claim-form";
import { Card, SelfService } from "@/components/people/self-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { errorText, isMoney, rowErrors, today, useCategories } from "@/lib/api/people";

function NewClaim() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const categories = useCategories();
  const [claimDate, setClaimDate] = useState(today);
  const [purpose, setPurpose] = useState("");
  const [lines, setLines] = useState<LineDraft[]>(() => [blankLine()]);
  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const byId = new Map((categories.data?.results ?? []).map((c) => [c.id, c]));
      const claim = await unwrap(api.POST("/api/v1/expenses/claims/", {
        body: { claim_date: claimDate, purpose: purpose.trim(), lines: lines.map((l) => lineToApi(l, Boolean(byId.get(l.category)?.requires_vehicle))) },
      }));
      if (!submit) return { claim, submitted: false };
      try {
        const sent = await unwrap(api.POST("/api/v1/expenses/claims/{id}/submit/", { params: { path: { id: claim.id } }, body: { version: claim.version } }));
        return { claim: sent, submitted: true };
      } catch (error) {
        return { claim, submitted: false, error };
      }
    },
    onSuccess: ({ claim, submitted, error }) => {
      queryClient.invalidateQueries({ queryKey: ["people", "my", "claims"] });
      if (error) toast.error(`Saved as draft ${claim.number}, but not submitted: ${errorText(error)}`);
      else toast(submitted ? `Claim ${claim.number} submitted for approval` : `Draft ${claim.number} saved`);
      router.push(`/me/expenses/${claim.id}`);
    },
  });
  if (categories.isLoading) return <RowsSkeleton />;
  if (categories.error) return <ErrorState error={categories.error} onRetry={categories.refetch} />;
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  const ready = purpose.trim() && lines.every((l) => l.category && l.description.trim() && isMoney(l.amount) && l.expense_date);
  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(true); }}>
      <FormError message={save.error && !isApiError(save.error, "validation_error") ? errorText(save.error) : (errors.lines ?? errors._form ?? errors.employee)} />
      <RowErrorList errors={rowErrors(save.error)} unit="Line" />
      <Card className="grid gap-3 p-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:p-5">
        <Field id="claim-date" label="Claim date" error={errors.claim_date}><Input id="claim-date" type="date" className="h-11" value={claimDate} onChange={(e) => setClaimDate(e.target.value)} required /></Field>
        <Field id="claim-purpose" label="Purpose" error={errors.purpose}><Input id="claim-purpose" className="h-11" value={purpose} maxLength={300} placeholder="e.g. Client visit, Mumbai" onChange={(e) => setPurpose(e.target.value)} required /></Field>
      </Card>
      <ClaimLinesEditor lines={lines} onChange={setLines} categories={categories.data?.results ?? []} />
      <div className="sticky bottom-0 -mx-4 grid grid-cols-2 gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:flex sm:justify-end sm:border-0 sm:bg-transparent sm:p-0">
        <Button type="button" variant="outline" size="lg" disabled={save.isPending || !ready} onClick={() => save.mutate(false)}>Save draft</Button>
        <Button type="submit" size="lg" disabled={save.isPending || !ready}>Submit claim</Button>
      </div>
    </form>
  );
}

export function NewClaimView() {
  return (
    <SelfService title="New expense claim" description="Add each expense with its receipt. Your approver sees the total and the receipts." back={{ href: "/me/expenses", label: "My expenses" }}>
      {() => <NewClaim />}
    </SelfService>
  );
}
