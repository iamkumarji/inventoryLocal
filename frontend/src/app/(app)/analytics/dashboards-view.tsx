"use client";

import { useQuery } from "@tanstack/react-query";
import { EyeOff, Info } from "lucide-react";

import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, RowsSkeleton } from "@/components/erp/states";
import { DateRange, FilterBar } from "@/components/finance/controls";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { type Dashboard, type Widget, formatDecimal, monthStart, today } from "@/lib/api/finance";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";

const DASHBOARD_LABEL: Record<string, string> = {
  management: "Management", finance: "Finance", procurement: "Procurement", production: "Production", warehouse: "Warehouse", sales: "Sales",
};

const UNIT_HINT: Record<Widget["unit"], string> = { inr: "₹", days: "days", pct: "%", ratio: "times", count: "count" };

/** Supporting figures returned with a KPI, so every number can be traced to its inputs. */
const DETAIL: Record<string, { label: string; kind: "inr" | "pct" | "ratio" | "count" | "qty" }> = {
  receivables: { label: "Receivables", kind: "inr" }, net_sales: { label: "Net sales", kind: "inr" },
  payables: { label: "Payables", kind: "inr" }, cogs: { label: "Cost of goods sold", kind: "inr" },
  average_inventory: { label: "Average inventory", kind: "inr" }, annualised: { label: "Annualised", kind: "ratio" },
  planned: { label: "Planned", kind: "inr" }, actual: { label: "Actual", kind: "inr" }, variance_pct: { label: "Variance", kind: "pct" },
  budgets: { label: "Approved budgets", kind: "count" }, customers: { label: "Customers", kind: "count" }, suppliers: { label: "Suppliers", kind: "count" },
  order_value: { label: "Order value", kind: "inr" }, awaiting_approval: { label: "Awaiting approval", kind: "count" },
  credit_blocked: { label: "Credit blocked", kind: "count" }, lines: { label: "Lines due", kind: "count" }, otif_lines: { label: "On time in full", kind: "count" },
  scrap_pct: { label: "Scrap", kind: "pct" }, material_cost: { label: "Material cost", kind: "inr" }, scrap_cost: { label: "Scrap cost", kind: "inr" },
  output_quantity: { label: "Output quantity", kind: "qty" }, late: { label: "Late", kind: "count" }, warehouses: { label: "Warehouses", kind: "count" },
  adjustments_awaiting_approval: { label: "Adjustments awaiting approval", kind: "count" }, transfers_in_transit: { label: "Transfers in transit", kind: "count" },
  counts_open: { label: "Stock counts open", kind: "count" },
};

type Scalar = string | number | null | undefined;

function formatValue(value: Scalar, unit: Widget["unit"] | "qty"): string {
  if (value === null || value === undefined) return "—";
  switch (unit) {
    case "inr": return formatDecimal(value, { currency: true, dp: 0 });
    case "days": return `${formatDecimal(value, { dp: 1 })} days`;
    case "pct": return `${formatDecimal(value, { dp: 1 })}%`;
    case "ratio": return `${formatDecimal(value, { dp: 2 })}×`;
    case "qty": return formatDecimal(value, { dp: 2 });
    default: return formatDecimal(value, { dp: 0 });
  }
}

function WidgetCard({ w }: { w: Widget }) {
  const noData = w.value === null || w.value === undefined;
  const details = Object.entries(w).filter(([k, v]) => DETAIL[k] && (typeof v === "string" || typeof v === "number" || v === null));
  const accounts = Array.isArray(w.accounts) ? (w.accounts as { account: string; name: string; balance: string }[]) : [];
  const byStatus = w.by_status && typeof w.by_status === "object" ? Object.entries(w.by_status as Record<string, number>) : [];
  return (
    <article className="flex flex-col rounded-lg border bg-card" aria-labelledby={`w-${w.key}`}>
      <header className="flex items-baseline justify-between gap-2 px-4 pt-3.5">
        <h2 id={`w-${w.key}`} className="text-sm font-medium text-muted-foreground">{w.label}</h2>
        <span className="text-[0.7rem] tracking-wide text-muted-foreground/80 uppercase">{UNIT_HINT[w.unit]}</span>
      </header>
      <div className="px-4 pt-1 pb-3">
        {noData ? (
          <p className="flex items-center gap-1.5 py-1 text-lg font-semibold text-muted-foreground" data-testid={`kpi-${w.key}`}>
            <Info className="size-4" aria-hidden /> Not enough data
          </p>
        ) : (
          <p className="num type-signage text-[1.9rem]" data-testid={`kpi-${w.key}`}>{formatValue(w.value, w.unit)}</p>
        )}
        {noData && <p className="text-xs text-muted-foreground">There isn&apos;t enough activity in this range to calculate it (for example, no sales or no cost of sales yet).</p>}
      </div>
      {(details.length > 0 || accounts.length > 0 || byStatus.length > 0) && (
        <dl className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-t px-4 py-3 text-xs">
          {details.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="truncate text-muted-foreground">{DETAIL[k].label}</dt>
              <dd className="num text-right">{formatValue(v as Scalar, DETAIL[k].kind)}</dd>
            </div>
          ))}
          {accounts.map((a) => (
            <div key={a.account} className="contents">
              <dt className="truncate text-muted-foreground">{a.account} {a.name}</dt>
              <dd className="num text-right">{formatValue(a.balance, "inr")}</dd>
            </div>
          ))}
          {byStatus.map(([status, n]) => (
            <div key={status} className="contents">
              <dt className="truncate text-muted-foreground capitalize">{status.replace(/_/g, " ")}</dt>
              <dd className="num text-right">{n}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

export function DashboardsView() {
  const url = useUrlState();
  const index = useQuery({ queryKey: ["analytics", "dashboards"], queryFn: () => unwrap(api.GET("/api/v1/analytics/dashboards/")), staleTime: 10 * 60_000 });
  const names = index.data?.dashboards ?? [];
  const name = url.get("d") || names[0] || "management";
  const from = url.get("from") || monthStart();
  const to = url.get("to") || today();
  const q = useQuery({
    queryKey: ["analytics", "dashboard", name, from, to],
    queryFn: async () => (await unwrap(api.GET("/api/v1/analytics/dashboards/{name}/", { params: { path: { name }, query: { date_from: from, date_to: to } } }))) as unknown as Dashboard,
    enabled: names.length > 0,
    placeholderData: (prev) => (prev?.dashboard === name ? prev : undefined),
  });
  return (
    <>
      <PageHeader title="Dashboards" description="Key figures from posted ledgers and live documents. Each figure only covers what your access lets you see." />
      <Tabs value={name} onValueChange={(v) => url.set({ d: v })} className="mb-4">
        <div className="max-w-full overflow-x-auto">
          <TabsList aria-label="Dashboard">
            {names.map((n) => <TabsTrigger key={n} value={n}>{DASHBOARD_LABEL[n] ?? n}</TabsTrigger>)}
          </TabsList>
        </div>
      </Tabs>
      <FilterBar><DateRange from={from} to={to} onChange={(r) => url.set({ from: r.from, to: r.to })} /></FilterBar>
      {index.error || q.error ? <Section><ErrorState error={index.error ?? q.error} onRetry={() => { index.refetch(); q.refetch(); }} /></Section> :
        !q.data ? <Section><RowsSkeleton /></Section> : (
          <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-6 transition-opacity", q.isFetching && "opacity-60")}>
            {q.data.widgets.length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {q.data.widgets.map((w) => <WidgetCard key={w.key} w={w} />)}
              </div>
            )}
            {q.data.hidden.length > 0 && (
              <Section title="Not shown to you" description="These figures need access you don't have. Ask an administrator if your role should include them.">
                <ul className="divide-y">
                  {q.data.hidden.map((h) => (
                    <li key={h.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm" data-testid={`hidden-${h.key}`}>
                      <EyeOff className="size-4 text-muted-foreground" aria-hidden />
                      <span className="font-medium">{h.label}</span>
                      <span className="text-muted-foreground">needs <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{h.needs}</code></span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
        )}
    </>
  );
}
