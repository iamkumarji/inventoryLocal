"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Landmark, Link2, Plus, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { ActionError } from "@/components/finance/action-error";
import { Amount } from "@/components/finance/amount";
import { AsOf, Figures } from "@/components/finance/controls";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { AccountPicker } from "@/components/finance/pickers";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import {
  type BankAccount, type ImportResult, type Reconciliation, type StatementLine, fromUnits, today, toUnits, useAccounts, useBankAccounts,
} from "@/lib/api/finance";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";

const SAMPLE = "date,description,reference,debit,credit,balance";

function AddBankAccount({ linked, onCreated }: { linked: Set<string>; onCreated: (b: BankAccount) => void }) {
  const { activeCompany } = useSession();
  const { withStepUp } = useStepUp();
  const accounts = useAccounts();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ account: "", bank_name: "", ifsc: "", account_last4: "" });
  const candidates = (accounts.data ?? []).filter((a) => !a.is_group && (a.sub_type === "bank" || a.sub_type === "cash") && !linked.has(a.id));
  const create = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/finance/bank-accounts/", { body: { company: activeCompany!.id, ...form, is_active: true } }))),
    onSuccess: (b) => { setOpen(false); setForm({ account: "", bank_name: "", ifsc: "", account_last4: "" }); onCreated(b); },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus aria-hidden /> Add bank account</Button></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Add a company bank account</DialogTitle>
            <DialogDescription>Each bank account is tied to one ledger account of type Bank or Cash in the chart of accounts.</DialogDescription>
          </DialogHeader>
          <Field id="bank-ledger" label="Ledger account">
            <AccountPicker id="bank-ledger" accounts={candidates} value={form.account} onChange={(id) => setForm({ ...form, account: id })} placeholder="Choose a bank ledger account" />
          </Field>
          <Field id="bank_name" label="Bank and branch"><Input id="bank_name" value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} required maxLength={150} /></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field id="ifsc" label="IFSC"><Input id="ifsc" value={form.ifsc} onChange={(e) => setForm({ ...form, ifsc: e.target.value.toUpperCase() })} maxLength={11} className="num" /></Field>
            <Field id="account_last4" label="Last 4 digits"><Input id="account_last4" value={form.account_last4} inputMode="numeric" maxLength={4}
              onChange={(e) => /^\d{0,4}$/.test(e.target.value) && setForm({ ...form, account_last4: e.target.value })} className="num" /></Field>
          </div>
          <ActionError error={create.error} />
          <DialogFooter><Button type="submit" disabled={!form.account || !form.bank_name.trim() || create.isPending}>Add account</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportStatement({ bank, onImported }: { bank: BankAccount; onImported: () => void }) {
  const { withStepUp } = useStepUp();
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const run = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/finance/bank-accounts/{id}/import-statement/", { params: { path: { id: bank.id } }, body: { csv } }))),
    onSuccess: (data) => { setResult(data as unknown as ImportResult); setCsv(""); onImported(); },
    onMutate: () => setResult(null),
  });
  return (
    <Section title="Import a statement" description="CSV with columns date (YYYY-MM-DD), description, reference, debit, credit, balance. The whole file is rejected if any row was already imported.">
      <form className="grid gap-3 px-5 py-4" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="file" accept=".csv,text/csv" aria-label="Statement CSV file" className="h-9 w-full sm:w-72"
            onChange={async (e) => { const file = e.target.files?.[0]; if (file) setCsv(await file.text()); }} />
          <span className="text-xs text-muted-foreground">or paste it below</span>
        </div>
        <Textarea aria-label="Statement CSV" value={csv} onChange={(e) => setCsv(e.target.value)} rows={5} placeholder={`${SAMPLE}\n2026-10-30,NEFT from customer,UTR123,,5000.00,125000.00`}
          className="num font-mono text-xs" />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!csv.trim() || run.isPending}><Upload aria-hidden /> {run.isPending ? "Importing…" : "Import statement"}</Button>
          {result && (
            <p role="status" className="flex items-center gap-1.5 text-sm font-medium text-status-approved">
              <CheckCircle2 className="size-4" aria-hidden /> Imported {result.imported} {result.imported === 1 ? "line" : "lines"}; {result.auto_matched} matched automatically.
            </p>
          )}
        </div>
        <ActionError error={run.error} />
      </form>
    </Section>
  );
}

function MatchDialog({ bank, line, candidates, onMatched }: {
  bank: BankAccount; line: StatementLine; candidates: Reconciliation["unreconciled_book_items"]; onMatched: () => void;
}) {
  const { withStepUp } = useStepUp();
  const [open, setOpen] = useState(false);
  const same = candidates.filter((c) => toUnits(c.amount) === toUnits(line.amount));
  const match = useMutation({
    mutationFn: (journalLine: string) => withStepUp(() => unwrap(api.POST("/api/v1/finance/bank-accounts/{id}/match/", {
      params: { path: { id: bank.id } }, body: { statement_line: line.id, journal_line: journalLine },
    }))),
    onSuccess: () => { setOpen(false); toast("Statement line matched"); onMatched(); },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Link2 aria-hidden /> Match</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Match {date(line.txn_date)} · <span className="num">{fromUnits(toUnits(line.amount))}</span></DialogTitle>
          <DialogDescription>{line.description}{line.reference ? ` (${line.reference})` : ""}. Pick the ledger entry for the same amount.</DialogDescription>
        </DialogHeader>
        {same.length === 0 ? (
          <EmptyState title="No unreconciled ledger entry has this amount" description="Post the missing payment or receipt first, then match it here." />
        ) : (
          <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
            {same.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="num block font-medium">{c.number} · {date(c.date)}</span>
                  <span className="block truncate text-muted-foreground">{c.narration}</span>
                </span>
                <Button size="sm" onClick={() => match.mutate(c.id)} disabled={match.isPending}>Match</Button>
              </li>
            ))}
          </ul>
        )}
        <ActionError error={match.error} />
        <DialogFooter><Button variant="ghost" onClick={() => setOpen(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountWorkspace({ bank }: { bank: BankAccount }) {
  const { can } = useSession();
  const url = useUrlState();
  const queryClient = useQueryClient();
  const asOf = url.get("as_of") || today();
  const recon = useQuery({
    queryKey: ["finance", "bank", bank.id, "reconciliation", asOf],
    queryFn: async () => (await unwrap(api.GET("/api/v1/finance/bank-accounts/{id}/reconciliation/", { params: { path: { id: bank.id }, query: { as_of: asOf } } }))) as unknown as Reconciliation,
  });
  const statement = useQuery({
    queryKey: ["finance", "bank", bank.id, "statement"],
    queryFn: () => unwrap(api.GET("/api/v1/finance/bank-accounts/{id}/statement/", { params: { path: { id: bank.id } } })),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["finance", "bank", bank.id] });
  const r = recon.data;
  const difference = r && r.statement_balance !== null ? fromUnits(toUnits(r.book_balance) - toUnits(r.statement_balance), 4) : null;
  const canUpdate = can("finance.bank_account.update");

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6">
      <Section title="Reconciliation" description="Ledger balance against the last statement balance on or before the date."
        actions={<AsOf id="recon-as-of" value={asOf} onChange={(v) => url.set({ as_of: v })} />}>
        {recon.error ? <ErrorState error={recon.error} onRetry={recon.refetch} /> : !r ? <RowsSkeleton rows={2} /> : (
          <div className="grid gap-4 p-5">
            <Figures items={[
              { label: "Ledger balance", value: <Amount value={r.book_balance} /> },
              { label: "Statement balance", value: r.statement_balance === null ? <span className="text-muted-foreground">No statement yet</span> : <Amount value={r.statement_balance} /> },
              { label: "Difference", value: difference === null ? "—" : toUnits(difference) === BigInt(0)
                ? <span className="flex items-center gap-1 text-status-approved"><CheckCircle2 className="size-4" aria-hidden /> Reconciled</span>
                : <Amount value={difference} /> },
              { label: "Still to match", value: <span className="num">{r.unmatched_statement_lines} statement · {r.unreconciled_book_items.length} ledger</span> },
            ]} />
            {r.unreconciled_book_items.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium">Ledger entries not yet on a statement</h3>
                <LedgerTable caption="Unreconciled ledger entries" columns={[{ key: "date", header: "Date" }, { key: "no", header: "Entry" }, { key: "narr", header: "Narration" }, { key: "amt", header: "Amount", align: "right" }]}>
                  {r.unreconciled_book_items.map((i) => (
                    <Row key={i.id}><Cell className="whitespace-nowrap">{date(i.date)}</Cell><Cell>{i.number}</Cell><Cell className="min-w-48 font-sans">{i.narration}</Cell><Cell align="right"><Amount value={i.amount} /></Cell></Row>
                  ))}
                </LedgerTable>
              </div>
            )}
          </div>
        )}
      </Section>
      {canUpdate && <ImportStatement bank={bank} onImported={refresh} />}
      <Section title="Statement lines" description="Deposits are positive, withdrawals negative.">
        {statement.error ? <ErrorState error={statement.error} onRetry={statement.refetch} /> : !statement.data ? <RowsSkeleton /> :
          statement.data.length === 0 ? <EmptyState icon={Landmark} title="No statement imported yet" /> : (
            <LedgerTable caption="Bank statement lines" columns={[
              { key: "date", header: "Date" }, { key: "desc", header: "Description" }, { key: "ref", header: "Reference" },
              { key: "amount", header: "Amount", align: "right" }, { key: "balance", header: "Balance", align: "right" }, { key: "status", header: "Status" },
            ]}>
              {statement.data.map((line) => (
                <Row key={line.id}>
                  <Cell className="whitespace-nowrap">{date(line.txn_date)}</Cell>
                  <Cell className="min-w-48 font-sans">{line.description}</Cell>
                  <Cell>{line.reference}</Cell>
                  <Cell align="right"><Amount value={line.amount} currency={false} /></Cell>
                  <Cell align="right"><Amount value={line.balance} currency={false} /></Cell>
                  <Cell>
                    {line.status === "unmatched" ? (
                      <span className="flex items-center gap-2">
                        <StatusBadge tone="pending">Unmatched</StatusBadge>
                        {canUpdate && r && <MatchDialog bank={bank} line={line} candidates={r.unreconciled_book_items} onMatched={refresh} />}
                      </span>
                    ) : <StatusBadge tone={line.status === "matched" ? "approved" : "neutral"}>{line.status === "matched" ? "Matched" : "Ignored"}</StatusBadge>}
                  </Cell>
                </Row>
              ))}
            </LedgerTable>
          )}
      </Section>
    </div>
  );
}

export function BankView() {
  const { can } = useSession();
  const url = useUrlState();
  const queryClient = useQueryClient();
  const banks = useBankAccounts();
  const list = banks.data?.results ?? [];
  const selectedId = url.get("account") || list[0]?.id || "";
  const selected = list.find((b) => b.id === selectedId);
  return (
    <>
      <PageHeader title="Banking" description="Company bank accounts, statement imports and reconciliation against the ledger."
        actions={can("finance.bank_account.create") && <AddBankAccount linked={new Set(list.map((b) => b.account))}
          onCreated={(b) => { queryClient.invalidateQueries({ queryKey: ["finance", "bank-accounts"] }); url.set({ account: b.id }); toast(`${b.bank_name} added`); }} />} />
      {banks.error ? <Section><ErrorState error={banks.error} onRetry={banks.refetch} /></Section> : !banks.data ? <Section><RowsSkeleton /></Section> :
        list.length === 0 ? <Section><EmptyState icon={Landmark} title="No bank accounts yet" description="Add the company's current accounts to record payments and reconcile statements." /></Section> : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <nav aria-label="Bank accounts" className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
              {list.map((b) => (
                <button key={b.id} type="button" onClick={() => url.set({ account: b.id, as_of: null })} aria-current={b.id === selectedId ? "true" : undefined}
                  className={cn("min-w-48 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/60",
                    b.id === selectedId && "border-foreground/60 shadow-[inset_3px_0_0_var(--marking)]")}>
                  <span className="block font-medium">{b.bank_name}</span>
                  <span className="num block text-xs text-muted-foreground">{b.ifsc || "No IFSC"}{b.account_last4 ? ` · ••${b.account_last4}` : ""}</span>
                  {b.is_active === false && <StatusBadge tone="neutral" className="mt-1">Inactive</StatusBadge>}
                </button>
              ))}
            </nav>
            {selected ? <AccountWorkspace key={selected.id} bank={selected} /> : <EmptyState title="Choose a bank account" />}
          </div>
        )}
    </>
  );
}
