"use client";

import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { LineChart } from "lucide-react";
import { useState } from "react";

import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Figures } from "@/components/finance/controls";
import { ForecastChart } from "@/components/finance/forecast-chart";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { ItemPicker, type ItemOption } from "@/components/finance/pickers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { type Forecast, formatDecimal } from "@/lib/api/finance";
import { useUrlState } from "@/lib/use-url-state";

const METHODS = { moving_average: "Moving average", exponential_smoothing: "Exponential smoothing" } as const;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ALPHAS = ["0.10", "0.20", "0.30", "0.40", "0.50", "0.60", "0.70", "0.80", "0.90"];

function NumberSelect({ id, label, value, options, onChange, suffix = "" }: {
  id: string; label: string; value: string; options: (string | number)[]; onChange: (v: string) => void; suffix?: string;
}) {
  return (
    <Field id={id} label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-28"><SelectValue /></SelectTrigger>
        <SelectContent>{options.map((o) => <SelectItem key={o} value={String(o)}>{o}{suffix}</SelectItem>)}</SelectContent>
      </Select>
    </Field>
  );
}

export function ForecastView() {
  const url = useUrlState();
  const [item, setItem] = useState<ItemOption | null>(null);
  const itemId = url.get("item");
  const method = (url.get("method") || "moving_average") as keyof typeof METHODS;
  const windowSize = url.get("window") || "3";
  const alpha = url.get("alpha") || "0.30";
  const history = url.get("history") || "12";
  const horizon = url.get("horizon") || "3";
  const q = useQuery({
    queryKey: ["analytics", "forecast", itemId, method, windowSize, alpha, history, horizon],
    queryFn: async () => (await unwrap(api.GET("/api/v1/analytics/forecast/", {
      params: { query: { item: itemId, method, window: Number(windowSize), alpha, history_months: Number(history), horizon_months: Number(horizon) } },
    }))) as unknown as Forecast,
    enabled: !!itemId,
  });
  const shown = item ?? (q.data ? q.data.item : null);

  return (
    <>
      <PageHeader title="Demand forecast" description="Monthly consumption from the stock ledger (sales and production issues, net of returns), projected forward. Both methods forecast a level, not a trend or seasonality." />
      <Section className="mb-6">
        <div className="flex flex-wrap items-end gap-4 px-5 py-4">
          <Field id="forecast-item" label="Item" className="w-full min-w-0 sm:w-auto"><ItemPicker id="forecast-item" value={shown} onChange={(i) => { setItem(i); url.set({ item: i.id }); }} /></Field>
          <Field id="forecast-method" label="Method">
            <Select value={method} onValueChange={(v) => url.set({ method: v })}>
              <SelectTrigger id="forecast-method" className="w-52"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(METHODS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {method === "moving_average"
            ? <NumberSelect id="forecast-window" label="Window" value={windowSize} options={range(1, 12)} suffix=" mo" onChange={(v) => url.set({ window: v })} />
            : <NumberSelect id="forecast-alpha" label="Smoothing (α)" value={alpha} options={ALPHAS} onChange={(v) => url.set({ alpha: v })} />}
          <NumberSelect id="forecast-history" label="History" value={history} options={[6, 12, 18, 24, 36]} suffix=" mo" onChange={(v) => url.set({ history: v })} />
          <NumberSelect id="forecast-horizon" label="Horizon" value={horizon} options={range(1, 12)} suffix=" mo" onChange={(v) => url.set({ horizon: v })} />
        </div>
      </Section>
      {!itemId ? <Section><EmptyState icon={LineChart} title="Choose an item" description="Pick a stocked item to see its monthly demand and forecast." /></Section> :
        q.error ? (isApiError(q.error) && q.error.status === 404
          ? <Section><EmptyState icon={LineChart} title="No demand history you can see for this item"
            description="Forecasts read the stock ledger of the warehouses your access covers. Ask for stock ledger read access, or choose another item." /></Section>
          : <Section><ErrorState error={q.error} onRetry={q.refetch} /></Section>) : !q.data ? <Section><RowsSkeleton /></Section> : (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
            <Figures items={[
              { label: "Forecast per month", value: <span className="num">{formatDecimal(q.data.forecast[0]?.demand, { dp: 2 })}</span>, hint: `${q.data.forecast.length} months ahead` },
              { label: "Mean absolute deviation", value: q.data.mad === null ? <span className="text-muted-foreground">Not enough data</span> : <span className="num">{formatDecimal(q.data.mad, { dp: 2 })}</span>,
                hint: q.data.mad === null ? "Needs more months of history than the window" : `Typical miss over ${q.data.observations} months` },
              { label: "Method", value: METHODS[q.data.method], hint: q.data.method === "moving_average" ? `Last ${q.data.parameters.window} months` : `α = ${q.data.parameters.alpha}` },
              { label: "Item", value: <span className="text-sm">{q.data.item.code}</span>, hint: q.data.item.name },
            ]} />
            <Section title={`${q.data.item.code} monthly demand`} description="Shaded months are forecast. Hover or tap for values.">
              <div className="px-5 py-4"><ForecastChart history={q.data.history} forecast={q.data.forecast} /></div>
              <details className="border-t">
                <summary className="cursor-pointer px-5 py-2.5 text-sm font-medium">Table view</summary>
                <LedgerTable caption="Monthly demand and forecast" columns={[{ key: "m", header: "Month" }, { key: "k", header: "" }, { key: "d", header: "Quantity", align: "right" }]}>
                  {[...q.data.history.map((p) => ({ ...p, k: "Actual" })), ...q.data.forecast.map((p) => ({ ...p, k: "Forecast" }))].map((p) => (
                    <Row key={`${p.k}-${p.month}`}><Cell>{format(parseISO(p.month), "MMM yyyy")}</Cell><Cell className="font-sans text-muted-foreground">{p.k}</Cell><Cell align="right">{formatDecimal(p.demand, { dp: 3 })}</Cell></Row>
                  ))}
                </LedgerTable>
              </details>
            </Section>
          </div>
        )}
    </>
  );
}
