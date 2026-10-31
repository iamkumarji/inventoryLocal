"use client";

import { useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import { useState } from "react";

import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Amount } from "@/components/finance/amount";
import { Figures, Unavailable } from "@/components/finance/controls";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, unwrap } from "@/lib/api/client";
import { type BudgetVsActualRow, type Dashboard, sumDecimals, today, useCostCenters } from "@/lib/api/finance";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
          <Cell className="min-w-48"><span className="mr-2 text-muted-foreground">{r.account}</span><span className="font-sans">{r.name}</span></Cell>
          <Cell>{cc(r.cost_center_id)}</Cell>
          <Cell align="right"><Amount value={r.planned} /></Cell>
          <Cell align="right"><Amount value={r.actual} /></Cell>
          <Cell align="right" className="font-semibold"><Amount value={r.variance} /></Cell>
        </Row>
      ))}
    </LedgerTable>
  );
}

export function BudgetsView() {
  const { can, flag } = useSession();
  const url = useUrlState();
  const budgetId = url.get("budget");
  const [draft, setDraft] = useState(budgetId);
  return (
    <>
      <PageHeader title="Budgets" description="Planned amounts per account and cost centre, compared with posted actuals for the fiscal year. A negative variance means spending above plan." />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
        {flag("module.analytics") && can("analytics.dashboard.read") && can("finance.report.read") && <YearToDate />}
        <Unavailable title="Entering and approving budgets">
          Creating budgets, entering their monthly lines and approving them isn&apos;t available on this screen yet. Approved budgets are already counted in the year-to-date figures above and in the finance dashboard.
        </Unavailable>
        <Section title="Budget against actual" description="Open a budget by its reference to compare each line with posted actuals.">
          <form className="flex flex-wrap items-end gap-2 border-b px-5 py-3" onSubmit={(e) => { e.preventDefault(); url.set({ budget: draft.trim() }); }}>
            <div className="grid gap-1">
              <Label htmlFor="budget-ref" className="text-xs text-muted-foreground">Budget reference</Label>
              <Input id="budget-ref" value={draft} onChange={(e) => setDraft(e.target.value)} className="num h-9 w-full sm:w-96" placeholder="e.g. 01920c3e-…" />
            </div>
            <Button type="submit" variant="outline" disabled={!UUID.test(draft.trim())}>Show</Button>
          </form>
          {budgetId && UUID.test(budgetId) ? <VsActual budgetId={budgetId} /> : <EmptyState icon={Scale} title="No budget open" />}
        </Section>
      </div>
    </>
  );
}
