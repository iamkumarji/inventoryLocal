"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { Check, Pencil, Plus, Scale, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { ActionError } from "@/components/finance/action-error";
import { Amount } from "@/components/finance/amount";
import { Figures } from "@/components/finance/controls";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { AccountPicker } from "@/components/finance/pickers";
import { useStepUp } from "@/components/shell/step-up";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import {
  type BudgetVsActualRow, type Dashboard, type FiscalYear, formatDecimal, fromUnits, postable, sumDecimals, today, toUnits,
  useAccounts, useCostCenters,
} from "@/lib/api/finance";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";

type Budget = components["schemas"]["Budget"];
type BudgetLineInput = components["schemas"]["BudgetLineRequest"];

const BUDGETS_KEY = ["finance", "budgets"] as const;
const AMOUNT = /^\d*(\.\d{0,4})?$/;
const ZERO = BigInt(0);

function BudgetStatus({ status }: { status: string }) {
  if (status === "approved") return <StatusBadge tone="approved">Approved</StatusBadge>;
  if (status === "draft") return <StatusBadge tone="neutral">Draft</StatusBadge>;
  return <StatusBadge tone="neutral">{status}</StatusBadge>;
}

function useFiscalYears() {
  const { activeCompany } = useSession();
  return useQuery({
    queryKey: ["organization", "fiscal-years", activeCompany?.id],
    queryFn: () => unwrap(api.GET("/api/v1/organization/fiscal-years/", {
      params: { query: { company: activeCompany?.id, ordering: "-start_date", page_size: 50 } },
    })),
    staleTime: 5 * 60_000,
  });
}

/** Period labels from the fiscal year's own calendar (e.g. "Apr 26"); falls back to 1–12. */
function periodsOf(year: FiscalYear | undefined): { no: number; label: string }[] {
  if (year && year.periods.length > 0) {
    return [...year.periods].sort((a, b) => a.period_no - b.period_no)
      .map((p) => ({ no: p.period_no, label: format(parseISO(p.start_date), "MMM yy") }));
  }
  return Array.from({ length: 12 }, (_, i) => ({ no: i + 1, label: `P${i + 1}` }));
}

/** "1200.5000" → "1200.5" for editing, exactly (string work only). */
function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/** Splits an annual figure (≤ 2 decimals) over n periods in paise; the last period takes the remainder. */
function spread(total: string, n: number): string[] {
  const paise = toUnits(total) / BigInt(100);
  const base = paise / BigInt(n);
  const last = paise - base * BigInt(n - 1);
  return Array.from({ length: n }, (_, i) => trimDecimal(fromUnits((i === n - 1 ? last : base) * BigInt(100), 2)));
}

function YearToDate() {
  const q = useQuery({
    queryKey: ["analytics", "dashboard", "finance", "budget-ytd"],
    queryFn: async () => (await unwrap(api.GET("/api/v1/analytics/dashboards/{name}/", { params: { path: { name: "finance" }, query: { date_to: today() } } }))) as unknown as Dashboard,
  });
  const w = q.data?.widgets.find((x) => x.key === "budget_variance");
  if (q.isLoading) return <RowsSkeleton rows={1} />;
  if (!w) return null;
  return (
    <Figures items={[
      { label: "Approved budgets this year", value: <span className="num">{String(w.budgets ?? 0)}</span> },
      { label: "Planned to date", value: <Amount value={w.planned as string} /> },
      { label: "Actual to date", value: <Amount value={w.actual as string} /> },
      { label: "Variance (planned − actual)", value: w.value === null ? <span className="text-muted-foreground">Not enough data</span> : <Amount value={w.value as string} /> },
    ]} />
  );
}

function VsActual({ budgetId }: { budgetId: string }) {
  const costCenters = useCostCenters();
  const q = useQuery({
    queryKey: ["finance", "budget", budgetId, "vs-actual"],
    queryFn: async () => (await unwrap(api.GET("/api/v1/finance/budgets/{budget_id}/vs-actual/", { params: { path: { budget_id: budgetId } } }))) as unknown as BudgetVsActualRow[],
  });
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  if (!q.data) return <RowsSkeleton />;
  if (q.data.length === 0) return <EmptyState icon={Scale} title="This budget has no lines" />;
  const rows = q.data;
  const cc = (id: string | null) => (id ? costCenters.data?.results.find((c) => c.id === id)?.code ?? "—" : "All");
  return (
    <LedgerTable caption="Budget against actual" columns={[
      { key: "account", header: "Account" }, { key: "cc", header: "Cost centre" }, { key: "planned", header: "Planned", align: "right" },
      { key: "actual", header: "Actual", align: "right" }, { key: "variance", header: "Variance", align: "right" },
    ]} footer={
      <Row className="hover:bg-transparent">
        <Cell colSpan={2} className="font-semibold">Total</Cell>
        {(["planned", "actual", "variance"] as const).map((k) => <Cell key={k} align="right" className="font-semibold"><Amount value={sumDecimals(rows.map((r) => r[k]))} /></Cell>)}
      </Row>
    }>
      {rows.map((r, i) => (
        <Row key={`${r.account}-${r.cost_center_id}-${i}`}>
          <Cell className="min-w-48"><span className="mr-2 text-muted-foreground">{r.account}</span>{" "}<span className="font-sans">{r.name}</span></Cell>
          <Cell>{cc(r.cost_center_id)}</Cell>
          <Cell align="right"><Amount value={r.planned} /></Cell>
          <Cell align="right"><Amount value={r.actual} /></Cell>
          <Cell align="right" className="font-semibold"><Amount value={r.variance} /></Cell>
        </Row>
      ))}
    </LedgerTable>
  );
}

// --- Editor ---------------------------------------------------------------------------------------

type EditRow = { key: number; account: string; costCenter: string; amounts: Record<number, string>; annual: string };
let nextKey = 1;
const blankRow = (): EditRow => ({ key: nextKey++, account: "", costCenter: "", amounts: {}, annual: "" });

function rowsFrom(budget: Budget | undefined): EditRow[] {
  if (!budget || budget.lines.length === 0) return [blankRow()];
  const grouped = new Map<string, EditRow>();
  for (const line of budget.lines) {
    const id = `${line.account}|${line.cost_center ?? ""}`;
    const row = grouped.get(id) ?? { ...blankRow(), account: line.account, costCenter: line.cost_center ?? "" };
    row.amounts[line.period_no] = trimDecimal(line.amount);
    grouped.set(id, row);
  }
  return [...grouped.values()];
}

function BudgetEditor({ budget, onDone, onCancel }: { budget?: Budget; onDone: (id: string) => void; onCancel: () => void }) {
  const { activeCompany } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const costCenters = useCostCenters();
  const years = useFiscalYears();
  const leaf = postable(accounts.data);
  const yearList = years.data?.results ?? [];
  const [name, setName] = useState(budget?.name ?? "");
  const [fiscalYear, setFiscalYear] = useState(budget?.fiscal_year ?? "");
  const [rows, setRows] = useState<EditRow[]>(() => rowsFrom(budget));
  const chosenYear = fiscalYear || yearList.find((y) => y.status === "open")?.id || "";
  const year = yearList.find((y) => y.id === chosenYear);
  const periods = periodsOf(year);
  const ccList = costCenters.data?.results ?? [];

  const update = (key: number, patch: Partial<EditRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const setAmount = (row: EditRow, period: number, value: string) => {
    if (AMOUNT.test(value)) update(row.key, { amounts: { ...row.amounts, [period]: value } });
  };
  const rowTotal = (r: EditRow) => periods.reduce((acc, p) => acc + toUnits(r.amounts[p.no]), ZERO);
  const grand = rows.reduce((acc, r) => acc + rowTotal(r), ZERO);
  const ids = rows.map((r) => `${r.account}|${r.costCenter}`);
  const problem = (r: EditRow, i: number): string | null => {
    if (!r.account) return "Choose an account.";
    if (ids.indexOf(ids[i]) !== i) return "This account and cost centre already have a row; combine them.";
    if (rowTotal(r) === ZERO) return "Enter an amount for at least one month.";
    return null;
  };
  const problems = rows.map(problem);
  const ready = name.trim().length > 0 && Boolean(chosenYear) && rows.length > 0 && problems.every((p) => p === null);

  const lines = (): BudgetLineInput[] => rows.flatMap((r) => periods
    .filter((p) => toUnits(r.amounts[p.no]) > ZERO)
    .map((p) => ({ account: r.account, cost_center: r.costCenter || null, period_no: p.no, amount: fromUnits(toUnits(r.amounts[p.no]), 4) })));

  const save = useMutation({
    mutationFn: () => withStepUp(() => budget
      ? unwrap(api.PATCH("/api/v1/finance/budgets/{id}/", { params: { path: { id: budget.id } }, body: { name: name.trim(), lines: lines(), version: budget.version } }))
      : unwrap(api.POST("/api/v1/finance/budgets/", { body: { company: activeCompany!.id, fiscal_year: chosenYear, name: name.trim(), lines: lines() } }))),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: BUDGETS_KEY });
      queryClient.invalidateQueries({ queryKey: ["finance", "budget", saved.id] });
      toast(budget ? "Budget saved" : "Budget created as a draft");
      onDone(saved.id);
    },
    onError: (error) => {
      if (budget && isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["finance", "budget", budget.id] });
    },
  });

  if (!activeCompany) return <Section><EmptyState title="Choose a company first" description="Budgets belong to one company." /></Section>;

  return (
    <Section title={budget ? `Edit ${budget.name}` : "New budget"}
      description="Monthly planned amounts per posting account, optionally per cost centre. Only drafts can be edited; approval locks it.">
      <form className="grid gap-5 px-5 py-4" onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate(); }}>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Field id="budget-name" label="Name">
            <Input id="budget-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="e.g. Operating budget FY 2026-27" />
          </Field>
          <Field id="budget-year" label="Fiscal year"
            error={years.error ? (isApiError(years.error) && years.error.status === 403 ? "You can't list fiscal years. Ask for organization fiscal-year read access." : "Couldn't load fiscal years.") : undefined}
            hint={budget ? "Fixed once the budget exists." : undefined}>
            <Select value={chosenYear} onValueChange={setFiscalYear} disabled={Boolean(budget) || years.isLoading}>
              <SelectTrigger id="budget-year" className="w-full"><SelectValue placeholder={years.isLoading ? "Loading…" : "Choose"} /></SelectTrigger>
              <SelectContent>
                {yearList.map((y) => <SelectItem key={y.id} value={y.id}>{y.code} ({date(y.start_date)} – {date(y.end_date)})</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="grid gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium">Lines</h3>
            <p className="text-sm text-muted-foreground">Total <Amount value={fromUnits(grand, 4)} className="font-semibold text-foreground" /></p>
          </div>
          {rows.map((r, i) => (
            <fieldset key={r.key} className={cn("grid gap-3 rounded-md border p-3", problems[i] && (r.account || rowTotal(r) > ZERO) && "border-status-pending/50")}>
              <legend className="sr-only">Line {i + 1}</legend>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
                <div className="grid min-w-0 gap-1.5">
                  <Label htmlFor={`acc-${r.key}`} className="text-xs text-muted-foreground">Account</Label>
                  <AccountPicker id={`acc-${r.key}`} accounts={leaf} value={r.account} onChange={(account) => update(r.key, { account })} />
                </div>
                <div className="grid min-w-0 gap-1.5">
                  <Label htmlFor={`cc-${r.key}`} className="text-xs text-muted-foreground">Cost centre</Label>
                  <Select value={r.costCenter || "none"} onValueChange={(v) => update(r.key, { costCenter: v === "none" ? "" : v })}>
                    <SelectTrigger id={`cc-${r.key}`} className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">All (none)</SelectItem>
                      {ccList.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} · {c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={rows.length === 1}
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="justify-self-end">
                  <Trash2 aria-hidden />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2 min-[30rem]:grid-cols-3 sm:grid-cols-4 lg:grid-cols-6">
                {periods.map((p) => (
                  <div key={p.no} className="grid min-w-0 gap-1">
                    <Label htmlFor={`amt-${r.key}-${p.no}`} className="text-xs text-muted-foreground">{p.label}</Label>
                    <Input id={`amt-${r.key}-${p.no}`} inputMode="decimal" value={r.amounts[p.no] ?? ""} placeholder="0"
                      onChange={(e) => setAmount(r, p.no, e.target.value)} className="num h-9 text-right" />
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="flex items-end gap-2">
                  <div className="grid gap-1">
                    <Label htmlFor={`annual-${r.key}`} className="text-xs text-muted-foreground">Annual amount</Label>
                    <Input id={`annual-${r.key}`} inputMode="decimal" value={r.annual} placeholder="0.00" className="num h-9 w-32 text-right"
                      onChange={(e) => /^\d*(\.\d{0,2})?$/.test(e.target.value) && update(r.key, { annual: e.target.value })} />
                  </div>
                  <Button type="button" size="sm" variant="outline" disabled={toUnits(r.annual) === ZERO}
                    onClick={() => update(r.key, { amounts: Object.fromEntries(spread(r.annual, periods.length).map((v, n) => [periods[n].no, v])), annual: "" })}>
                    Spread evenly
                  </Button>
                </div>
                <p className="text-sm">Line total <Amount value={fromUnits(rowTotal(r), 4)} className="font-semibold" /></p>
              </div>
              {problems[i] && (r.account || rowTotal(r) > ZERO) && <p className="text-sm text-status-pending">{problems[i]}</p>}
            </fieldset>
          ))}
          <Button type="button" variant="outline" className="justify-self-start" onClick={() => setRows((rs) => [...rs, blankRow()])}>
            <Plus aria-hidden /> Add line
          </Button>
        </div>

        <ActionError error={save.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!ready || save.isPending}>{save.isPending ? "Saving…" : budget ? "Save draft" : "Create draft"}</Button>
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          {!ready && <p className="self-center text-sm text-muted-foreground">Name the budget, pick a fiscal year and complete each line.</p>}
        </div>
      </form>
    </Section>
  );
}

// --- One budget -----------------------------------------------------------------------------------

function LinesGrid({ budget, year }: { budget: Budget; year: FiscalYear | undefined }) {
  const costCenters = useCostCenters();
  const accounts = useAccounts();
  const periods = periodsOf(year);
  const rows = rowsFrom(budget).filter((r) => r.account);
  if (rows.length === 0) return <EmptyState icon={Scale} title="No lines yet" description="Edit the draft to add monthly amounts." />;
  const accountLabel = (id: string) => {
    const a = accounts.data?.find((x) => x.id === id);
    return a ? <><span className="mr-2 text-muted-foreground">{a.code}</span>{" "}<span className="font-sans">{a.name}</span></> : budget.lines.find((l) => l.account === id)?.account_code ?? "—";
  };
  const cc = (id: string) => (id ? costCenters.data?.results.find((c) => c.id === id)?.code ?? "—" : "All");
  return (
    <LedgerTable caption="Budget lines by month" columns={[
      { key: "account", header: "Account" }, { key: "cc", header: "Cost centre" },
      ...periods.map((p) => ({ key: `p${p.no}`, header: p.label, align: "right" as const })),
      { key: "total", header: "Total", align: "right" },
    ]} footer={
      <Row className="hover:bg-transparent">
        <Cell colSpan={2} className="font-semibold">Total</Cell>
        {periods.map((p) => <Cell key={p.no} align="right" className="font-semibold"><Amount value={sumDecimals(rows.map((r) => r.amounts[p.no]))} currency={false} muteZero /></Cell>)}
        <Cell align="right" className="font-bold"><Amount value={budget.total} /></Cell>
      </Row>
    }>
      {rows.map((r) => (
        <Row key={`${r.account}|${r.costCenter}`}>
          <Cell className="min-w-48">{accountLabel(r.account)}</Cell>
          <Cell>{cc(r.costCenter)}</Cell>
          {periods.map((p) => <Cell key={p.no} align="right"><Amount value={r.amounts[p.no] ?? "0"} currency={false} muteZero /></Cell>)}
          <Cell align="right" className="font-semibold"><Amount value={sumDecimals(Object.values(r.amounts))} /></Cell>
        </Row>
      ))}
    </LedgerTable>
  );
}

function BudgetPanel({ budgetId, editing, onEdit, onEditDone, onClose }: {
  budgetId: string;
  editing: boolean;
  onEdit: () => void;
  onEditDone: () => void;
  onClose: () => void;
}) {
  const { can, me } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const years = useFiscalYears();
  const q = useQuery({
    queryKey: ["finance", "budget", budgetId],
    queryFn: () => unwrap(api.GET("/api/v1/finance/budgets/{id}/", { params: { path: { id: budgetId } } })),
  });
  const approve = useMutation({
    mutationFn: (b: Budget) => withStepUp(() => unwrap(api.POST("/api/v1/finance/budgets/{id}/approve/", { params: { path: { id: b.id } }, body: { version: b.version } }))),
    onSuccess: (b) => {
      queryClient.setQueryData(["finance", "budget", b.id], b);
      queryClient.invalidateQueries({ queryKey: BUDGETS_KEY });
      queryClient.invalidateQueries({ queryKey: ["analytics", "dashboard", "finance"] });
      toast(`${b.name} approved`);
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["finance", "budget", budgetId] });
    },
  });

  if (q.error) return <Section><ErrorState error={q.error} onRetry={q.refetch} /></Section>;
  if (!q.data) return <Section><RowsSkeleton /></Section>;
  const b = q.data;
  if (editing && b.status === "draft") return <BudgetEditor key={`${b.id}-${b.version}`} budget={b} onDone={onEditDone} onCancel={onEditDone} />;
  const year = years.data?.results.find((y) => y.id === b.fiscal_year);
  const draft = b.status === "draft";
  const preparedByMe = b.created_by === me.user.id;

  return (
    <>
      <Section
        title={<span className="flex flex-wrap items-center gap-2">{b.name} <BudgetStatus status={b.status} /></span>}
        description={`${year ? `Fiscal year ${year.code}` : "Fiscal year"} · total ${formatDecimal(b.total, { currency: true })} · created ${date(b.created_at)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {draft && can("finance.budget.update") && <Button size="sm" variant="outline" onClick={onEdit}><Pencil aria-hidden /> Edit</Button>}
            {draft && can("finance.budget.approve") && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" disabled={approve.isPending}><Check aria-hidden /> Approve</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Approve {b.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Its {formatDecimal(b.total, { currency: true })} becomes the plan that variance reports compare against, and the budget can no longer be edited.
                      Someone other than the person who prepared it must approve.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => approve.mutate(b)}>Approve budget</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close budget"><X aria-hidden /></Button>
          </div>
        }
      >
        {(approve.error || (draft && preparedByMe && can("finance.budget.approve"))) && (
          <div className="grid gap-2 border-b px-5 py-3">
            {draft && preparedByMe && !approve.error && (
              <p className="text-sm text-muted-foreground">You prepared this budget, so a colleague with budget approval rights must approve it.</p>
            )}
            <ActionError error={approve.error} hints={{
              self_approval: "Ask a colleague with budget approval rights to approve it.",
              maker_checker: "Ask a colleague with budget approval rights to approve it.",
            }} />
          </div>
        )}
        <LinesGrid budget={b} year={year} />
      </Section>
      <Section title="Budget against actual" description="Each line's planned total compared with posted actuals for the fiscal year. A negative variance means spending above plan.">
        <VsActual budgetId={b.id} />
      </Section>
    </>
  );
}

// --- Page -----------------------------------------------------------------------------------------

export function BudgetsView() {
  const { can, flag } = useSession();
  const url = useUrlState();
  const budgetId = url.get("budget");
  const mode = url.get("mode"); // "new" | "edit"
  const status = url.get("status");
  const fy = url.get("fy");
  const years = useFiscalYears();
  const list = useQuery({
    queryKey: [...BUDGETS_KEY, status, fy, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/finance/budgets/", {
      params: { query: { status: status || undefined, fiscal_year: fy || undefined, page: url.page, ordering: "-created_at" } },
    })),
  });
  const yearCode = (id: string) => years.data?.results.find((y) => y.id === id)?.code ?? "—";
  const columns: Column<Budget>[] = [
    { key: "name", header: "Budget", cell: (b) => <span className={cn("block min-w-40", b.id === budgetId && "underline decoration-primary decoration-2 underline-offset-4")}>{b.name}</span> },
    { key: "fy", header: "Fiscal year", cell: (b) => <span className="num whitespace-nowrap">{yearCode(b.fiscal_year)}</span> },
    { key: "status", header: "Status", cell: (b) => <BudgetStatus status={b.status} /> },
    { key: "lines", header: "Lines", align: "right", cell: (b) => <span className="num">{b.lines.length}</span> },
    { key: "total", header: "Total", align: "right", cell: (b) => <Amount value={b.total} /> },
    { key: "created", header: "Created", cell: (b) => <span className="whitespace-nowrap text-muted-foreground">{date(b.created_at)}</span> },
  ];
  const href = (b: Budget) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (fy) params.set("fy", fy);
    if (url.page > 1) params.set("page", String(url.page));
    params.set("budget", b.id);
    return `/finance/budgets?${params.toString()}`;
  };

  return (
    <>
      <PageHeader title="Budgets" description="Planned amounts per account and cost centre for a fiscal year. Drafts can be edited; once a different person approves one, it drives variance reporting."
        actions={can("finance.budget.create") && mode !== "new" && (
          <Button onClick={() => url.set({ mode: "new", budget: null })}><Plus aria-hidden /> New budget</Button>
        )} />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
        {flag("module.analytics") && can("analytics.dashboard.read") && can("finance.report.read") && <YearToDate />}
        {mode === "new" && can("finance.budget.create") && (
          <BudgetEditor onDone={(id) => url.set({ mode: null, budget: id })} onCancel={() => url.set({ mode: null })} />
        )}
        {budgetId && mode !== "new" && (
          <BudgetPanel key={budgetId} budgetId={budgetId} editing={mode === "edit"}
            onEdit={() => url.set({ mode: "edit" })} onEditDone={() => url.set({ mode: null })} onClose={() => url.set({ budget: null, mode: null })} />
        )}
        <Section title="All budgets" actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
              {[["", "All"], ["draft", "Draft"], ["approved", "Approved"]].map(([v, label]) => (
                <Button key={v || "all"} size="sm" variant={status === v ? "secondary" : "ghost"} aria-pressed={status === v} onClick={() => url.set({ status: v })}>{label}</Button>
              ))}
            </div>
            {(years.data?.results.length ?? 0) > 0 && (
              <Select value={fy || "any"} onValueChange={(v) => url.set({ fy: v === "any" ? null : v })}>
                <SelectTrigger className="h-8 w-40" aria-label="Fiscal year"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any fiscal year</SelectItem>
                  {years.data!.results.map((y) => <SelectItem key={y.id} value={y.id}>{y.code}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
        }>
          <DataTable columns={columns} rows={list.data?.results} isLoading={list.isLoading} error={list.error} onRetry={list.refetch}
            rowHref={href} caption="Budgets"
            empty={<EmptyState icon={Scale} title="No budgets match"
              description={can("finance.budget.create") ? "Create a budget with monthly amounts per account, then have a colleague approve it." : "Budgets your finance team prepares appear here."} />} />
          {list.data && <PageNav page={url.page} count={list.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
        </Section>
      </div>
    </>
  );
}
