"use client";

import { useQuery } from "@tanstack/react-query";
import { BookOpen, CheckCircle2, Scale, XCircle } from "lucide-react";
import Link from "next/link";

import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Amount, DrCr, Side } from "@/components/finance/amount";
import { AsOf, DateRange, FilterBar, defaultRange } from "@/components/finance/controls";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { AccountPicker } from "@/components/finance/pickers";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import {
  type BalanceSheet, type Ledger, type ProfitAndLoss, type StatementRow, type TrialBalance,
  formatDecimal, isNegative, sumDecimals, useAccounts,
} from "@/lib/api/finance";
import { date } from "@/lib/format";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";

const VIEWS = [
  { key: "trial-balance", label: "Trial balance" },
  { key: "profit-and-loss", label: "Profit & loss" },
  { key: "balance-sheet", label: "Balance sheet" },
  { key: "ledger", label: "Account ledger" },
] as const;

function BalanceCheck({ balanced, okText, badText }: { balanced: boolean; okText: string; badText: string }) {
  return (
    <p role="status" className={cn("flex items-center gap-2 border-b px-5 py-2.5 text-sm font-medium",
      balanced ? "bg-status-approved/10 text-status-approved" : "bg-status-rejected/10 text-status-rejected")}>
      {balanced ? <CheckCircle2 className="size-4" aria-hidden /> : <XCircle className="size-4" aria-hidden />}
      {balanced ? okText : badText}
    </p>
  );
}

function TrialBalanceReport({ from, to, onDrill }: { from: string; to: string; onDrill: (accountId: string) => void }) {
  const q = useQuery({
    queryKey: ["finance", "reports", "trial-balance", from, to],
    queryFn: async () => (await unwrap(api.GET("/api/v1/finance/reports/trial-balance/", { params: { query: { date_from: from, date_to: to } } }))) as unknown as TrialBalance,
  });
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  if (!q.data) return <RowsSkeleton />;
  const tb = q.data;
  if (tb.rows.length === 0) return <EmptyState icon={Scale} title="Nothing posted in this range" description="Posted journals, invoices and payments appear here. Drafts don't count until they're posted." />;
  return (
    <>
      <BalanceCheck balanced={tb.balanced} okText={`Balanced: debits equal credits (${formatDecimal(tb.totals.debit, { currency: true })}).`}
        badText={`Out of balance: debits ${formatDecimal(tb.totals.debit, { currency: true })}, credits ${formatDecimal(tb.totals.credit, { currency: true })}.`} />
      <LedgerTable caption={`Trial balance ${from} to ${to}`} columns={[
        { key: "code", header: "Code" }, { key: "name", header: "Account" },
        { key: "opening", header: "Opening", align: "right" }, { key: "debit", header: "Debit", align: "right" },
        { key: "credit", header: "Credit", align: "right" }, { key: "closing", header: "Closing", align: "right" },
      ]} footer={
        <Row className="hover:bg-transparent">
          <Cell colSpan={2} className="font-semibold">Total</Cell>
          <Cell align="right"><DrCr value={tb.totals.opening} /></Cell>
          <Cell align="right" className="font-semibold"><Side value={tb.totals.debit} /></Cell>
          <Cell align="right" className="font-semibold"><Side value={tb.totals.credit} /></Cell>
          <Cell align="right"><DrCr value={tb.totals.closing} /></Cell>
        </Row>
      }>
        {tb.rows.map((r) => (
          <Row key={r.account_id}>
            <Cell className="text-muted-foreground">{r.code}</Cell>
            <Cell className="min-w-44">
              <button type="button" className="text-left font-medium underline-offset-4 hover:underline" onClick={() => onDrill(r.account_id)}
                aria-label={`Open ledger for ${r.code} ${r.name}`}>
                {r.name}
              </button>
            </Cell>
            <Cell align="right"><DrCr value={r.opening} /></Cell>
            <Cell align="right"><Side value={r.debit} /></Cell>
            <Cell align="right"><Side value={r.credit} /></Cell>
            <Cell align="right"><DrCr value={r.closing} /></Cell>
          </Row>
        ))}
      </LedgerTable>
    </>
  );
}

function StatementSection({ title, rows, total, totalLabel }: { title: string; rows: StatementRow[]; total: string; totalLabel: string }) {
  return (
    <>
      <Row className="bg-muted/40 hover:bg-muted/40">
        <Cell colSpan={2} heading className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</Cell>
      </Row>
      {rows.length === 0 && <Row><Cell colSpan={2} className="text-muted-foreground">No balances</Cell></Row>}
      {rows.map((r) => (
        <Row key={`${r.code}-${r.name}`}>
          <Cell className="pl-6"><span className="mr-2 text-muted-foreground">{r.code}</span>{r.name}</Cell>
          <Cell align="right"><Amount value={r.amount} currency={false} /></Cell>
        </Row>
      ))}
      <Row className="hover:bg-transparent">
        <Cell className="font-semibold">{totalLabel}</Cell>
        <Cell align="right" className="border-t border-foreground/40 font-semibold"><Amount value={total} currency={false} /></Cell>
      </Row>
    </>
  );
}

function ProfitAndLossReport({ from, to }: { from: string; to: string }) {
  const q = useQuery({
    queryKey: ["finance", "reports", "pnl", from, to],
    queryFn: async () => (await unwrap(api.GET("/api/v1/finance/reports/profit-and-loss/", { params: { query: { date_from: from, date_to: to } } }))) as unknown as ProfitAndLoss,
  });
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  if (!q.data) return <RowsSkeleton />;
  const p = q.data;
  const loss = isNegative(p.net_profit);
  return (
    <LedgerTable caption="Profit and loss" className="max-w-3xl" columns={[{ key: "line", header: "Line" }, { key: "amount", header: "Amount (₹)", align: "right" }]}
      footer={
        <Row className="hover:bg-transparent">
          <Cell className="text-base font-bold">{loss ? "Net loss" : "Net profit"}</Cell>
          <Cell align="right" className={cn("border-b-4 border-double border-foreground/60 text-base font-bold", loss && "text-status-rejected")}>
            <Amount value={p.net_profit} currency={false} />
          </Cell>
        </Row>
      }>
      <StatementSection title="Income" rows={p.income} total={p.total_income} totalLabel="Total income" />
      <StatementSection title="Expenses" rows={p.expenses} total={p.total_expense} totalLabel="Total expenses" />
    </LedgerTable>
  );
}

function BalanceSheetReport({ asOf }: { asOf: string }) {
  const q = useQuery({
    queryKey: ["finance", "reports", "balance-sheet", asOf],
    queryFn: async () => (await unwrap(api.GET("/api/v1/finance/reports/balance-sheet/", { params: { query: { as_of: asOf } } }))) as unknown as BalanceSheet,
  });
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  if (!q.data) return <RowsSkeleton />;
  const b = q.data;
  const claims = sumDecimals([b.totals.liability, b.totals.equity]);
  return (
    <>
      <BalanceCheck balanced={b.balanced} okText="Balanced: assets equal liabilities plus equity."
        badText={`Out of balance: assets ${formatDecimal(b.totals.asset, { currency: true })}, liabilities and equity ${formatDecimal(claims, { currency: true })}.`} />
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:divide-x">
        <LedgerTable caption="Assets" columns={[{ key: "line", header: "Assets" }, { key: "amount", header: "₹", align: "right" }]}>
          <StatementSection title="Assets" rows={b.sections.asset} total={b.totals.asset} totalLabel="Total assets" />
        </LedgerTable>
        <LedgerTable caption="Liabilities and equity" columns={[{ key: "line", header: "Liabilities and equity" }, { key: "amount", header: "₹", align: "right" }]}
          footer={
            <Row className="hover:bg-transparent">
              <Cell className="font-bold">Total liabilities and equity</Cell>
              <Cell align="right" className="font-bold"><Amount value={claims} currency={false} /></Cell>
            </Row>
          }>
          <StatementSection title="Liabilities" rows={b.sections.liability} total={b.totals.liability} totalLabel="Total liabilities" />
          <StatementSection title="Equity" rows={b.sections.equity} total={b.totals.equity} totalLabel="Total equity" />
        </LedgerTable>
      </div>
    </>
  );
}

function LedgerReport({ accountId, from, to }: { accountId: string; from: string; to: string }) {
  const q = useQuery({
    queryKey: ["finance", "reports", "ledger", accountId, from, to],
    queryFn: async () => (await unwrap(api.GET("/api/v1/finance/reports/ledger/{account_id}/", {
      params: { path: { account_id: accountId }, query: { date_from: from, date_to: to } },
    }))) as unknown as Ledger,
    enabled: !!accountId,
  });
  if (!accountId) return <EmptyState icon={BookOpen} title="Choose an account" description="Or open one from the trial balance." />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  if (!q.data) return <RowsSkeleton />;
  const l = q.data;
  return (
    <LedgerTable caption={`Ledger for ${l.account.code} ${l.account.name}`} columns={[
      { key: "date", header: "Date" }, { key: "entry", header: "Entry" }, { key: "narration", header: "Narration" },
      { key: "partner", header: "Partner" }, { key: "debit", header: "Debit", align: "right" },
      { key: "credit", header: "Credit", align: "right" }, { key: "balance", header: "Balance", align: "right" },
    ]} footer={
      <Row className="hover:bg-transparent">
        <Cell colSpan={6} className="font-semibold">Closing balance</Cell>
        <Cell align="right" className="font-semibold"><DrCr value={l.closing} /></Cell>
      </Row>
    }>
      <Row className="bg-muted/30 hover:bg-muted/30">
        <Cell colSpan={6} className="text-muted-foreground">Opening balance on {date(from)}</Cell>
        <Cell align="right"><DrCr value={l.opening} /></Cell>
      </Row>
      {l.lines.length === 0 && <Row><Cell colSpan={7} className="py-6 text-muted-foreground">No postings in this range.</Cell></Row>}
      {l.lines.map((line, i) => (
        <Row key={`${line.entry_id}-${i}`}>
          <Cell className="whitespace-nowrap">{date(line.date)}</Cell>
          <Cell className="whitespace-nowrap"><Link href={`/finance/journals/${line.entry_id}`} className="font-medium underline-offset-4 hover:underline">{line.number}</Link></Cell>
          <Cell className="min-w-56 max-w-[40ch] font-sans">{line.narration}</Cell>
          <Cell className="font-sans text-muted-foreground">{line.partner ?? ""}</Cell>
          <Cell align="right"><Side value={line.debit} /></Cell>
          <Cell align="right"><Side value={line.credit} /></Cell>
          <Cell align="right"><DrCr value={line.balance} /></Cell>
        </Row>
      ))}
    </LedgerTable>
  );
}

export function ReportsView() {
  const url = useUrlState();
  const fallback = defaultRange();
  const view = (url.get("view") || "trial-balance") as (typeof VIEWS)[number]["key"];
  const from = url.get("from") || fallback.from;
  const to = url.get("to") || fallback.to;
  const accountId = url.get("account");
  const accounts = useAccounts(view === "ledger");

  return (
    <>
      <PageHeader title="Financial statements" description="Computed from posted entries only. Every figure traces back to the ledger." />
      <Tabs value={view} onValueChange={(v) => url.set({ view: v === "trial-balance" ? null : v })} className="mb-4">
        <div className="max-w-full overflow-x-auto">
          <TabsList>
            {VIEWS.map((v) => <TabsTrigger key={v.key} value={v.key}>{v.label}</TabsTrigger>)}
          </TabsList>
        </div>
      </Tabs>
      <FilterBar>
        {view === "balance-sheet" ? (
          <AsOf value={to} onChange={(value) => url.set({ to: value })} />
        ) : (
          <DateRange from={from} to={to} onChange={(r) => url.set({ from: r.from, to: r.to })} />
        )}
        {view === "ledger" && (
          <div className="grid w-full gap-1 sm:w-80">
            <span className="text-xs text-muted-foreground" id="ledger-account-label">Account</span>
            <AccountPicker id="ledger-account" accounts={(accounts.data ?? []).filter((a) => !a.is_group)} value={accountId}
              onChange={(id) => url.set({ account: id })} />
          </div>
        )}
      </FilterBar>
      <Section>
        {view === "trial-balance" && <TrialBalanceReport from={from} to={to} onDrill={(id) => url.set({ view: "ledger", account: id })} />}
        {view === "profit-and-loss" && <ProfitAndLossReport from={from} to={to} />}
        {view === "balance-sheet" && <BalanceSheetReport asOf={to} />}
        {view === "ledger" && <LedgerReport accountId={accountId} from={from} to={to} />}
      </Section>
    </>
  );
}
