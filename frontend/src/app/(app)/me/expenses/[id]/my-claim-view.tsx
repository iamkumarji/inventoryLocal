"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/erp/field";
import { ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Facts } from "@/components/people/actions";
import { Amount, DocStatus } from "@/components/people/amount";
import { ClaimLines } from "@/components/people/claim";
import { SubmitClaim } from "@/components/people/claim-actions";
import { ClaimLinesEditor, lineFromApi, lineToApi, type LineDraft } from "@/components/people/claim-form";
import { ClaimAttachments, UploadReceiptButton, useReceiptAccess } from "@/components/people/receipts";
import { Card, SelfService } from "@/components/people/self-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { compareDecimal, errorText, isMoney, useCategories, type Claim } from "@/lib/api/people";
import { date } from "@/lib/format";

const STEPS: Record<string, string> = {
  draft: "Draft: not sent yet. Submit it when every expense is in.",
  submitted: "Waiting for approval.",
  approved: "Approved. Reimbursement is on its way.",
  rejected: "Rejected. Fix what the approver asked for and submit again.",
  paid: "Paid to your bank account.",
};

function Editor({ claim, onDone }: { claim: Claim; onDone: () => void }) {
  const queryClient = useQueryClient();
  const categories = useCategories();
  const { canUpload } = useReceiptAccess();
  const [purpose, setPurpose] = useState(claim.purpose);
  const [lines, setLines] = useState<LineDraft[]>(() => claim.lines.map(lineFromApi));
  const save = useMutation({
    mutationFn: () => {
      const byId = new Map((categories.data?.results ?? []).map((c) => [c.id, c]));
      return unwrap(api.PATCH("/api/v1/expenses/claims/{id}/", {
        params: { path: { id: claim.id } },
        body: { purpose: purpose.trim(), lines: lines.map((l) => lineToApi(l, Boolean(byId.get(l.category)?.requires_vehicle))), version: claim.version },
      }));
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["people", "claim", claim.id], data);
      queryClient.invalidateQueries({ queryKey: ["people", "my", "claims"] });
      toast("Claim saved");
      onDone();
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["people", "claim", claim.id] });
    },
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  const ready = purpose.trim() && lines.every((l) => l.category && l.description.trim() && isMoney(l.amount));
  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <FormError message={save.error ? (errors.lines ?? errorText(save.error)) : undefined} />
      <Card className="p-4 sm:p-5">
        <Field id="edit-purpose" label="Purpose" error={errors.purpose}><Input id="edit-purpose" className="h-11" value={purpose} maxLength={300} onChange={(e) => setPurpose(e.target.value)} required /></Field>
      </Card>
      <ClaimLinesEditor lines={lines} onChange={setLines} categories={categories.data?.results ?? []}
        lineExtra={canUpload ? (line, update) => (
          <UploadReceiptButton claimId={claim.id} label={line.receipt_reference ? "Replace receipt file" : "Attach receipt file"}
            onUploaded={(documentId) => update({ receipt_reference: documentId })} />
        ) : undefined} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>Discard changes</Button>
        <Button type="submit" disabled={save.isPending || !ready}>Save claim</Button>
      </div>
    </form>
  );
}

function MyClaim({ id }: { id: string }) {
  const [editing, setEditing] = useState(false);
  const claim = useQuery({
    queryKey: ["people", "claim", id],
    queryFn: () => unwrap(api.GET("/api/v1/expenses/claims/{id}/", { params: { path: { id } } })),
  });
  if (claim.isLoading) return <RowsSkeleton />;
  if (claim.error) return <ErrorState error={claim.error} onRetry={claim.refetch} />;
  const c = claim.data!;
  const open = c.status === "draft" || c.status === "rejected";
  if (editing && open) return <Editor key={c.version} claim={c} onDone={() => setEditing(false)} />;
  return (
    <div className="grid gap-4">
      <Card className="grid gap-2 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{c.number} · {date(c.claim_date)}</p>
            <h2 className="text-lg font-semibold">{c.purpose}</h2>
          </div>
          <DocStatus status={c.status} />
        </div>
        <p className="num text-2xl font-semibold"><Amount value={c.amount} currency={c.currency} /></p>
        <p className="text-sm text-muted-foreground">{STEPS[c.status] ?? ""}</p>
        {open && (
          <div className="mt-2 grid gap-2 sm:flex sm:flex-wrap sm:items-start">
            <SubmitClaim claim={c} size="lg" />
            <Button variant="outline" size="lg" onClick={() => setEditing(true)}><Pencil aria-hidden /> Edit</Button>
          </div>
        )}
      </Card>
      <Card>
        <h2 className="type-section border-b px-5 py-3">Expenses</h2>
        <ClaimLines claim={c} />
        <ClaimAttachments claimId={c.id} />
      </Card>
      {(c.status === "approved" || c.status === "paid") && (
        <Card>
          <Facts items={[
            ...(compareDecimal(c.advance_settled, "0") > 0 ? [["Advance settled", <Amount key="a" value={c.advance_settled} currency={c.currency} />] as [string, React.ReactNode]] : []),
            ["Paid to you", <Amount key="n" value={c.net_payable} currency={c.currency} />],
            ["Paid on", c.paid_on ? date(c.paid_on) : "Not yet"],
            ["Bank reference", c.bank_reference || "—"],
          ]} />
        </Card>
      )}
    </div>
  );
}

export function MyClaimView() {
  const { id } = useParams<{ id: string }>();
  return (
    <SelfService title="Expense claim" back={{ href: "/me/expenses", label: "My expenses" }}>
      {() => <MyClaim id={id} />}
    </SelfService>
  );
}
