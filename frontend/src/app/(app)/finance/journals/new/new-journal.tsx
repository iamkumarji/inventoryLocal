"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActionError } from "@/components/finance/action-error";
import { AccountPicker, PartnerPicker, type PartnerOption } from "@/components/finance/pickers";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { fromUnits, formatDecimal, postable, today, toUnits, useAccounts, useCostCenters } from "@/lib/api/finance";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

type Line = { key: number; account: string; debit: string; credit: string; cost_center: string; partner: PartnerOption | null; description: string };

let nextKey = 1;
const blank = (): Line => ({ key: nextKey++, account: "", debit: "", credit: "", cost_center: "", partner: null, description: "" });
const AMOUNT = /^\d*(\.\d{0,4})?$/;

export function NewJournal() {
  const { activeCompany, can } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { withStepUp } = useStepUp();
  const accounts = useAccounts();
  const costCenters = useCostCenters();
  const [entryDate, setEntryDate] = useState(today());
  const [narration, setNarration] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [blank(), blank()]);
  const leaf = postable(accounts.data);
  const byId = new Map(leaf.map((a) => [a.id, a]));

  const debit = lines.reduce((acc, l) => acc + toUnits(l.debit), BigInt(0));
  const credit = lines.reduce((acc, l) => acc + toUnits(l.credit), BigInt(0));
  const difference = debit - credit;
  const lineProblem = (l: Line): string | null => {
    if (!l.account) return "Choose an account";
    const d = toUnits(l.debit) > BigInt(0);
    const c = toUnits(l.credit) > BigInt(0);
    if (d === c) return "Enter a debit or a credit";
    if (byId.get(l.account)?.is_control && !l.partner) return "Name the customer or supplier";
    return null;
  };
  const problems = lines.map(lineProblem);
  const balanced = difference === BigInt(0) && debit > BigInt(0);
  const empty = debit === BigInt(0) && credit === BigInt(0);
  const ready = balanced && problems.every((p) => p === null) && narration.trim().length > 0 && lines.length >= 2;

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const create = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/finance/journal-entries/", {
      body: {
        company: activeCompany!.id,
        entry_date: entryDate,
        narration: narration.trim(),
        lines: lines.map((l) => ({
          account: l.account,
          debit: l.debit || "0",
          credit: l.credit || "0",
          cost_center: l.cost_center || null,
          partner: l.partner?.id ?? null,
          description: l.description,
        })),
      },
    }))),
    onSuccess: (entry) => {
      queryClient.invalidateQueries({ queryKey: ["finance", "journals"] });
      router.push(`/finance/journals/${entry.id}`);
    },
  });

  if (!can("finance.journal_entry.create")) {
    return <PageHeader title="New journal" description="You can't prepare journals. Ask a finance administrator for access." crumbs={[{ label: "Journals", href: "/finance/journals" }, { label: "New" }]} />;
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ready) create.mutate(); }}>
      <PageHeader crumbs={[{ label: "Journals", href: "/finance/journals" }, { label: "New" }]} title="New journal"
        description="Saved as a draft. Someone else posts it (maker-checker); posted entries are never edited." />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
        <Section title="Entry">
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <Field id="entry_date" label="Entry date"><Input id="entry_date" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} required /></Field>
            <Field id="narration" label="Narration" hint="Why this entry is needed; auditors read this.">
              <Textarea id="narration" value={narration} onChange={(e) => setNarration(e.target.value)} maxLength={500} rows={2} required />
            </Field>
          </div>
        </Section>

        <Section title="Lines" description="Each line is either a debit or a credit. Debits must equal credits."
          actions={<Button type="button" size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, blank()])}><Plus aria-hidden /> Add line</Button>}>
          <ol className="divide-y">
            {lines.map((l, index) => {
              const account = byId.get(l.account);
              const partnerKind = account?.sub_type === "payable" ? "supplier" : "customer";
              return (
                <li key={l.key} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-start">
                  <div className="grid gap-2">
                    <span className="text-xs font-medium text-muted-foreground" id={`line-${l.key}-label`}>Line {index + 1} account</span>
                    <AccountPicker id={`line-${index + 1}-account`} accounts={leaf} value={l.account} onChange={(id) => update(l.key, { account: id, partner: null })} />
                    {account?.is_control && (
                      <PartnerPicker id={`line-${index + 1}-partner`} kind={partnerKind} value={l.partner} onChange={(p) => update(l.key, { partner: p })}
                        placeholder={`Which ${partnerKind}? (control account)`} />
                    )}
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input aria-label={`Line ${index + 1} description`} placeholder="Line description (optional)" value={l.description}
                        maxLength={300} onChange={(e) => update(l.key, { description: e.target.value })} />
                      <Select value={l.cost_center || "none"} onValueChange={(v) => update(l.key, { cost_center: v === "none" ? "" : v })}>
                        <SelectTrigger aria-label={`Line ${index + 1} cost centre`} className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No cost centre</SelectItem>
                          {(costCenters.data?.results ?? []).filter((c) => c.is_active !== false).map((c) => (
                            <SelectItem key={c.id} value={c.id}>{c.code} · {c.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Field id={`line-${index + 1}-debit`} label="Debit">
                    <Input id={`line-${index + 1}-debit`} inputMode="decimal" className="num text-right" value={l.debit} placeholder="0.00"
                      onChange={(e) => AMOUNT.test(e.target.value) && update(l.key, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} />
                  </Field>
                  <Field id={`line-${index + 1}-credit`} label="Credit">
                    <Input id={`line-${index + 1}-credit`} inputMode="decimal" className="num text-right" value={l.credit} placeholder="0.00"
                      onChange={(e) => AMOUNT.test(e.target.value) && update(l.key, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} />
                  </Field>
                  <div className="flex items-center justify-between gap-2 md:mt-6 md:block">
                    {problems[index] && (l.account || l.debit || l.credit) && <span className="text-xs text-status-pending md:hidden">{problems[index]}</span>}
                    <Button type="button" variant="ghost" size="icon-sm" disabled={lines.length <= 2} aria-label={`Remove line ${index + 1}`}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 aria-hidden /></Button>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="sticky bottom-0 grid gap-3 border-t bg-card px-5 py-3 sm:flex sm:items-center sm:justify-between">
            <dl className="num grid grid-cols-3 gap-4 text-sm sm:flex sm:gap-6">
              <div><dt className="text-xs text-muted-foreground">Debits</dt><dd className="font-semibold">{formatDecimal(fromUnits(debit, 4), { currency: true })}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Credits</dt><dd className="font-semibold">{formatDecimal(fromUnits(credit, 4), { currency: true })}</dd></div>
              <div>
                <dt className="text-xs text-muted-foreground">Difference</dt>
                <dd role="status" className={cn("flex items-center gap-1 font-semibold", balanced ? "text-status-approved" : empty ? "text-muted-foreground" : "text-status-rejected")}>
                  {balanced ? <><CheckCircle2 className="size-4" aria-hidden /> Balanced</> : empty ? "Enter amounts" : formatDecimal(fromUnits(difference, 4), { currency: true })}
                </dd>
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
