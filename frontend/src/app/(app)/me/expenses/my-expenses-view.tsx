"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, HandCoins, Plus, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Field, FormError } from "@/components/erp/field";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Amount, DocStatus } from "@/components/people/amount";
import { Card, SelfService } from "@/components/people/self-service";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { compareDecimal, errorText, isMoney, useMyAdvances, type Advance } from "@/lib/api/people";
import { date } from "@/lib/format";

function RequestAdvance() {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [done, setDone] = useState<Advance | null>(null);
  const queryClient = useQueryClient();
  const request = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/expenses/advances/", { body: { amount: amount.trim(), purpose: purpose.trim() } })),
    onSuccess: (advance) => {
      setDone(advance); setAmount(""); setPurpose("");
      queryClient.invalidateQueries({ queryKey: ["people", "my", "advances"] });
    },
  });
  const errors = isApiError(request.error) ? request.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setDone(null); request.reset(); } }}>
      <DialogTrigger asChild><Button variant="outline"><HandCoins aria-hidden /> Request an advance</Button></DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-sm">
        {done ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Advance requested</DialogTitle>
              <DialogDescription>
                {done.number} for <Amount value={done.amount} currency={done.currency} /> is waiting for approval. Once it&apos;s paid, your later claims settle it.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter><Button onClick={() => setOpen(false)}>Done</Button></DialogFooter>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); request.mutate(); }}>
            <DialogHeader>
              <DialogTitle>Request an advance</DialogTitle>
              <DialogDescription>Money paid to you ahead of expenses, for example travel. Claims you file later settle it.</DialogDescription>
            </DialogHeader>
            <FormError message={request.error && !isApiError(request.error, "validation_error") ? errorText(request.error) : (errors._form ?? errors.employee)} />
            <Field id="adv-amount" label="Amount (₹)" error={errors.amount ?? (amount && !isMoney(amount) ? "Enter an amount like 5000 or 5000.50." : undefined)}>
              <Input id="adv-amount" inputMode="decimal" className="num h-11" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </Field>
            <Field id="adv-purpose" label="Purpose" error={errors.purpose}>
              <Input id="adv-purpose" className="h-11" value={purpose} maxLength={300} onChange={(e) => setPurpose(e.target.value)} required />
            </Field>
            <DialogFooter><Button type="submit" size="lg" disabled={request.isPending || !isMoney(amount) || !purpose.trim()}>Request advance</Button></DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MyClaims() {
  const claims = useQuery({ queryKey: ["people", "my", "claims"], queryFn: () => unwrap(api.GET("/api/v1/expenses/my/claims/")) });
  if (claims.isLoading) return <RowsSkeleton rows={3} />;
  if (claims.error) return <ErrorState error={claims.error} onRetry={claims.refetch} />;
  if (claims.data!.length === 0) {
    return <Card><EmptyState icon={Wallet} title="No expense claims yet" description="File a claim for travel, meals, fuel and other work expenses." action={<Button asChild><Link href="/me/expenses/new"><Plus aria-hidden /> New claim</Link></Button>} /></Card>;
  }
  return (
    <ul className="grid grid-cols-1 gap-2">
      {claims.data!.map((c) => (
        <li key={c.id}>
          <Link href={`/me/expenses/${c.id}`} className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 hover:border-input focus-visible:outline-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{c.purpose}</span>
              <span className="block text-sm text-muted-foreground">{c.number} · {date(c.claim_date)}</span>
            </span>
            <span className="grid justify-items-end gap-1">
              <Amount value={c.amount} currency={c.currency} className="font-semibold" />
              <DocStatus status={c.status} />
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

const ADVANCE_STEPS: Record<string, string> = {
  requested: "Waiting for approval",
  approved: "Approved; payment on its way",
  paid: "Paid to you; your next claims settle it",
  settled: "Settled by your claims",
  rejected: "Rejected",
};

/** The caller's advances (GET /expenses/my/advances/): status, what is still to settle, and any rejection reason. */
function MyAdvances() {
  const advances = useMyAdvances();
  if (advances.isLoading) return <RowsSkeleton rows={2} />;
  if (advances.error) return <ErrorState error={advances.error} onRetry={advances.refetch} />;
  const list = advances.data ?? [];
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="my-advances" className="grid gap-2">
      <h2 id="my-advances" className="type-section mt-4">Advances</h2>
      <ul className="grid grid-cols-1 gap-2">
        {list.map((a) => (
          <li key={a.id} className="grid gap-1 rounded-lg border bg-card px-4 py-3">
            <div className="flex items-start gap-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{a.purpose}</span>
                <span className="block text-sm text-muted-foreground">{a.number} · {date(a.created_at)}</span>
              </span>
              <span className="grid justify-items-end gap-1">
                <Amount value={a.amount} currency={a.currency} className="font-semibold" />
                <DocStatus status={a.status} />
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {ADVANCE_STEPS[a.status] ?? ""}
              {a.status === "paid" && compareDecimal(a.outstanding, "0") > 0 && <> · <Amount value={a.outstanding} currency={a.currency} /> outstanding</>}
            </p>
            {a.status === "rejected" && a.rejection_reason && <p className="text-sm"><span className="font-medium">Approver&apos;s comment:</span> {a.rejection_reason}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MyExpensesView() {
  return (
    <SelfService title="My expenses" description="File claims with receipts, follow approval and payment, and request advances."
      actions={<><Button asChild><Link href="/me/expenses/new"><Plus aria-hidden /> New claim</Link></Button><RequestAdvance /></>}>
      {() => <><MyClaims /><MyAdvances /></>}
    </SelfService>
  );
}
