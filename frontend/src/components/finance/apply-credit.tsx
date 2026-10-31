"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/erp/field";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { ActionError } from "@/components/finance/action-error";
import { Amount } from "@/components/finance/amount";
import { PartnerPicker, type PartnerOption } from "@/components/finance/pickers";
import { DOC_LABEL } from "@/components/finance/subledger";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { type OpenItem, absDecimal, formatDecimal, fromUnits, isNegative, toUnits } from "@/lib/api/finance";
import { date } from "@/lib/format";
import { cn } from "@/lib/utils";

const AMOUNT = /^\d*(\.\d{0,4})?$/;
const ZERO = BigInt(0);

function ItemChoice({ name, items, value, onChange, credit }: {
  name: string;
  items: OpenItem[];
  value: string;
  onChange: (item: OpenItem) => void;
  credit: boolean;
}) {
  return (
    <ul className="grid max-h-56 gap-1.5 overflow-y-auto pr-0.5">
      {items.map((i) => (
        <li key={i.id}>
          <label className={cn(
            "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm hover:bg-accent/60",
            value === i.id && "border-foreground/40 bg-accent/60",
          )}>
            <input type="radio" name={name} value={i.id} checked={value === i.id} onChange={() => onChange(i)} className="accent-foreground" />
            <span className="min-w-0 flex-1">
              <span className="num block truncate font-medium">{i.number}</span>
              <span className="block truncate text-xs text-muted-foreground">{DOC_LABEL[i.document_type] ?? i.document_type} · {date(i.document_date)}</span>
            </span>
            <span className="text-right">
              <Amount value={credit ? absDecimal(i.outstanding) : i.outstanding} className="block font-semibold" />
              <span className="block text-xs text-muted-foreground">{credit ? "available" : "outstanding"}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/**
 * Offsets a credit (credit note or on-account payment: an open item with negative outstanding) against an open
 * invoice of the same partner. Both open items are settled by the amount; no money moves.
 */
export function ApplyCreditDialog({ kind, label = "Apply credit", variant = "outline" }: {
  kind: "receivable" | "payable";
  label?: string;
  variant?: "outline" | "default" | "ghost";
}) {
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [partner, setPartner] = useState<PartnerOption | null>(null);
  const [credit, setCredit] = useState<OpenItem | null>(null);
  const [debit, setDebit] = useState<OpenItem | null>(null);
  const [amount, setAmount] = useState("");
  const [key, setKey] = useState(idempotencyKey);
  const partnerNoun = kind === "receivable" ? "customer" : "supplier";

  const items = useQuery({
    queryKey: ["finance", "open-items", kind, "partner", partner?.id],
    queryFn: () => unwrap(api.GET("/api/v1/finance/open-items/", {
      params: { query: { kind, partner: partner!.id, is_open: true, page_size: 200, ordering: "due_date" } },
    })),
    enabled: open && partner !== null,
  });
  const all = items.data?.results ?? [];
  const credits = all.filter((i) => isNegative(i.outstanding));
  const debits = all.filter((i) => toUnits(i.outstanding) > ZERO);

  const available = credit ? -toUnits(credit.outstanding) : ZERO;
  const due = debit ? toUnits(debit.outstanding) : ZERO;
  const max = available < due ? available : due;
  const entered = toUnits(amount);
  const amountProblem = !amount ? null : entered <= ZERO ? "Enter more than zero." : entered > max ? `At most ${formatDecimal(fromUnits(max, 4), { currency: true })}.` : null;
  const ready = Boolean(credit && debit) && entered > ZERO && !amountProblem;

  const pick = (nextCredit: OpenItem | null, nextDebit: OpenItem | null) => {
    setCredit(nextCredit);
    setDebit(nextDebit);
    if (nextCredit && nextDebit) {
      const a = -toUnits(nextCredit.outstanding);
      const d = toUnits(nextDebit.outstanding);
      setAmount(fromUnits(a < d ? a : d, 2));
    }
  };

  const apply = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/finance/open-items/apply-credit/", {
      body: { credit: credit!.id, debit: debit!.id, amount: fromUnits(entered, 4) },
      headers: { "Idempotency-Key": key },
    }))) as unknown as Promise<OpenItem[]>,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance", "open-items"] });
      queryClient.invalidateQueries({ queryKey: ["finance", "ageing"] });
      toast(`${formatDecimal(fromUnits(entered, 4), { currency: true })} of ${credit!.number} applied to ${debit!.number}`);
      reset(false);
    },
  });

  function reset(next: boolean) {
    setOpen(next);
    if (!next) {
      setPartner(null);
      setCredit(null);
      setDebit(null);
      setAmount("");
      setKey(idempotencyKey());
      apply.reset();
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button variant={variant}><ArrowRightLeft aria-hidden /> {label}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (ready) apply.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Apply a credit to an invoice</DialogTitle>
            <DialogDescription>
              {kind === "receivable"
                ? "Use a credit note or an on-account receipt to settle a customer's open invoice. No money moves; both items are reduced by the amount."
                : "Use a supplier credit note or an advance to settle an open supplier invoice. No money moves; both items are reduced by the amount."}
            </DialogDescription>
          </DialogHeader>
          <Field id="credit-partner" label={partnerNoun === "customer" ? "Customer" : "Supplier"}>
            <PartnerPicker id="credit-partner" kind={partnerNoun} value={partner}
              onChange={(p) => { setPartner(p); pick(null, null); setAmount(""); apply.reset(); }} />
          </Field>

          {partner && (items.isLoading ? <RowsSkeleton rows={3} /> : items.error ? <ErrorState error={items.error} onRetry={items.refetch} /> : (
            credits.length === 0 || debits.length === 0 ? (
              <EmptyState title={credits.length === 0 ? `No open credits for this ${partnerNoun}` : `No open invoices for this ${partnerNoun}`}
                description={credits.length === 0
                  ? "Credits are credit notes and unallocated payments: open items with a negative outstanding amount."
                  : "There's nothing to settle. The credit stays on account until an invoice is posted."} />
            ) : (
              <>
                <fieldset className="grid gap-2">
                  <legend className="mb-2 text-sm font-medium">Credit to use</legend>
                  <ItemChoice name="credit" items={credits} value={credit?.id ?? ""} onChange={(i) => pick(i, debit)} credit />
                </fieldset>
                <fieldset className="grid gap-2">
                  <legend className="mb-2 text-sm font-medium">Invoice to settle</legend>
                  <ItemChoice name="debit" items={debits} value={debit?.id ?? ""} onChange={(i) => pick(credit, i)} credit={false} />
                </fieldset>
                <Field id="credit-amount" label="Amount to apply" error={amountProblem ?? undefined}
                  hint={credit && debit ? `Up to ${formatDecimal(fromUnits(max, 4), { currency: true })}: the smaller of the credit and the invoice.` : "Choose a credit and an invoice first."}>
                  <Input id="credit-amount" inputMode="decimal" value={amount} disabled={!credit || !debit} className="num w-full sm:w-48"
                    onChange={(e) => AMOUNT.test(e.target.value) && setAmount(e.target.value)} />
                </Field>
              </>
            )
          ))}

          <ActionError error={apply.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => reset(false)}>Cancel</Button>
            <Button type="submit" disabled={!ready || apply.isPending}>
              {apply.isPending ? "Applying…" : ready ? `Apply ${formatDecimal(fromUnits(entered, 4), { currency: true })}` : "Apply"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
