"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState, RowsSkeleton } from "@/components/erp/states";
import { ActionError } from "@/components/finance/action-error";
import { Amount } from "@/components/finance/amount";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { PartnerPicker, type PartnerOption } from "@/components/finance/pickers";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { MODE_LABEL, type Payment, fromUnits, isPositiveAmount, today, toUnits, useBankAccounts } from "@/lib/api/finance";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";

const AMOUNT = /^\d*(\.\d{0,4})?$/;
const trim = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

export function NewPayment() {
  const { activeCompany } = useSession();
  const url = useUrlState();
  const kind = (url.get("kind") === "customer_receipt" ? "customer_receipt" : "supplier_payment") as Payment["kind"];
  const supplier = kind === "supplier_payment";
  const router = useRouter();
  const queryClient = useQueryClient();
  const banks = useBankAccounts();
  const [partner, setPartner] = useState<PartnerOption | null>(null);
  const [form, setForm] = useState({ bank_account: "", payment_date: today(), mode: "neft" as Payment["mode"], reference: "", amount: "" });
  const [alloc, setAlloc] = useState<Record<string, string>>({});

  const items = useQuery({
    queryKey: ["finance", "open-items", "for-payment", kind, partner?.id],
    queryFn: () => unwrap(api.GET("/api/v1/finance/open-items/", {
      params: { query: { kind: supplier ? "payable" : "receivable", partner: partner!.id, is_open: true, page_size: 200, ordering: "due_date" } },
    })),
    enabled: !!partner,
  });
  const invoices = (items.data?.results ?? []).filter((i) => toUnits(i.outstanding) > BigInt(0));
  const allocated = Object.values(alloc).reduce((acc, v) => acc + toUnits(v), BigInt(0));
  const amount = toUnits(form.amount);
  const unallocated = amount - allocated;
  const overAllocated = unallocated < BigInt(0);
  const allocProblems = invoices.some((i) => alloc[i.id] !== undefined && (!isPositiveAmount(alloc[i.id]) || toUnits(alloc[i.id]) > toUnits(i.outstanding)));
  const ready = partner && form.bank_account && isPositiveAmount(form.amount) && !overAllocated && !allocProblems;

  const toggle = (id: string, outstanding: string, on: boolean) => {
    setAlloc((a) => {
      const next = { ...a };
      if (!on) delete next[id];
      else {
        const remaining = amount - Object.entries(a).reduce((acc, [k, v]) => (k === id ? acc : acc + toUnits(v)), BigInt(0));
        const cap = toUnits(outstanding);
        const take = form.amount ? (remaining < cap ? remaining : cap) : cap;
        next[id] = trim(fromUnits(take > BigInt(0) ? take : cap, 4));
      }
      return next;
    });
  };

  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/finance/payments/", {
      body: {
        company: activeCompany!.id, kind, partner: partner!.id, bank_account: form.bank_account, payment_date: form.payment_date,
        mode: form.mode, reference: form.reference.trim(), amount: form.amount,
        allocations: Object.entries(alloc).map(([open_item, value]) => ({ open_item, amount: value })),
      },
    })),
    onSuccess: (p) => {
      queryClient.invalidateQueries({ queryKey: ["finance", "payments"] });
      router.push(`/finance/payments/${p.id}`);
    },
  });

  const title = supplier ? "New supplier payment" : "Record a customer receipt";
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ready) create.mutate(); }}>
      <PageHeader crumbs={[{ label: "Payments", href: "/finance/payments" }, { label: supplier ? "New payment" : "New receipt" }]} title={title}
        description={supplier ? "Saved as a draft. After you submit it, someone else approves it before it can be posted." : "Receipts are approved when submitted and can then be posted."} />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
        <Section title="Details">
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field id="partner" label={supplier ? "Supplier" : "Customer"}>
              <PartnerPicker id="partner" kind={supplier ? "supplier" : "customer"} value={partner} onChange={(p) => { setPartner(p); setAlloc({}); }} />
            </Field>
            <Field id="bank_account" label={supplier ? "Pay from" : "Deposited to"}>
              <Select value={form.bank_account} onValueChange={(v) => setForm({ ...form, bank_account: v })}>
                <SelectTrigger id="bank_account" className="w-full"><SelectValue placeholder="Choose a bank account" /></SelectTrigger>
                <SelectContent>
                  {(banks.data?.results ?? []).filter((b) => b.is_active !== false).map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.bank_name}{b.account_last4 ? ` ••${b.account_last4}` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {banks.data && banks.data.results.length === 0 && <p className="text-xs text-muted-foreground">No bank accounts yet. <Link className="underline" href="/finance/bank">Add one under Banking.</Link></p>}
            </Field>
            <Field id="payment_date" label="Date"><Input id="payment_date" type="date" value={form.payment_date} onChange={(e) => setForm({ ...form, payment_date: e.target.value })} required /></Field>
            <Field id="mode" label="Mode">
              <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as Payment["mode"] })}>
                <SelectTrigger id="mode" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(MODE_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field id="reference" label="Reference" hint="UTR, cheque number or bank reference. Helps auto-matching the bank statement.">
              <Input id="reference" value={form.reference} maxLength={80} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
            </Field>
            <Field id="amount" label="Amount (₹)">
              <Input id="amount" inputMode="decimal" className="num text-right" value={form.amount} required placeholder="0.00"
                onChange={(e) => AMOUNT.test(e.target.value) && setForm({ ...form, amount: e.target.value })} />
            </Field>
          </div>
        </Section>
        <Section title="Allocate to open items" description="Choose which invoices this settles. Anything not allocated stays on account as an advance.">
          {!partner ? <EmptyState title={`Choose a ${supplier ? "supplier" : "customer"} to see their open items`} /> :
            items.isLoading ? <RowsSkeleton rows={3} /> :
              invoices.length === 0 ? <EmptyState title="No open invoices" description="The whole amount will be recorded on account." /> : (
                <LedgerTable caption="Open items" columns={[
                  { key: "pick", header: <span className="sr-only">Allocate</span> }, { key: "number", header: "Document" },
                  { key: "due", header: "Due" }, { key: "outstanding", header: "Outstanding", align: "right" }, { key: "alloc", header: "Allocate", align: "right" },
                ]}>
                  {invoices.map((i) => (
                    <Row key={i.id}>
                      <Cell><Checkbox checked={alloc[i.id] !== undefined} onCheckedChange={(v) => toggle(i.id, i.outstanding, v === true)} aria-label={`Allocate to ${i.number}`} /></Cell>
                      <Cell>{i.number}</Cell>
                      <Cell className="whitespace-nowrap">{date(i.due_date)}</Cell>
                      <Cell align="right"><Amount value={i.outstanding} /></Cell>
                      <Cell align="right">
                        <Input className="num ml-auto h-8 w-32 text-right" inputMode="decimal" aria-label={`Amount allocated to ${i.number}`}
                          disabled={alloc[i.id] === undefined} value={alloc[i.id] ?? ""} aria-invalid={alloc[i.id] !== undefined && toUnits(alloc[i.id]) > toUnits(i.outstanding)}
                          onChange={(e) => AMOUNT.test(e.target.value) && setAlloc({ ...alloc, [i.id]: e.target.value })} />
                      </Cell>
                    </Row>
                  ))}
                </LedgerTable>
              )}
          <div className="grid gap-3 border-t px-5 py-3 sm:flex sm:items-center sm:justify-between">
            <dl className="num flex gap-6 text-sm">
              <div><dt className="text-xs text-muted-foreground">Allocated</dt><dd className="font-semibold"><Amount value={fromUnits(allocated, 4)} /></dd></div>
              <div>
                <dt className="text-xs text-muted-foreground">{overAllocated ? "Over-allocated" : "On account"}</dt>
                <dd className={cn("font-semibold", overAllocated && "text-status-rejected")}><Amount value={fromUnits(unallocated < BigInt(0) ? -unallocated : unallocated, 4)} /></dd>
              </div>
            </dl>
            <Button type="submit" disabled={!ready || create.isPending}>{create.isPending ? "Saving…" : "Save draft"}</Button>
          </div>
        </Section>
        <ActionError error={create.error} />
      </div>
    </form>
  );
}
