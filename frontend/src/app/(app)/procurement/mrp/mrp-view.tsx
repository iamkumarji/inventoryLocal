"use client";

import { useQuery } from "@tanstack/react-query";
import { Cog, Play } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ActionError, DocStatus, humanize } from "@/components/trade/common";
import { trim } from "@/components/trade/decimal";
import { useTradeAction } from "@/components/trade/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { tradeKey, useItemIndex } from "@/lib/api/trade";
import { dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

/** The MRP endpoint's suggestions are untyped in the OpenAPI schema; this is what the server returns. */
type Suggestion = {
  id: string; item_id: string; item_code: string; action: string; on_hand: string; open_supply: string; demand: string;
  reorder_level: string; suggested_quantity: string; status: string;
};

export function MrpView() {
  const { can } = useSession();
  const items = useItemIndex();
  const [horizon, setHorizon] = useState("30");
  const latest = useQuery({ queryKey: tradeKey("mrp"), queryFn: () => unwrap(api.GET("/api/v1/procurement/mrp/")) });
  const run = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/mrp/run/", { body: { horizon_days: Number(horizon || 30) } })),
  (r) => toast(`MRP run finished with ${(r as { suggestions?: number }).suggestions ?? 0} suggestions`));
  // The OpenAPI schema declares a list; the server actually returns one object for the latest run.
  const data = latest.data as unknown as { run: { id: string; run_at: string } | null; suggestions: Suggestion[] } | undefined;
  const rows = data?.suggestions ?? (latest.data ? [] : undefined);
  const runAt = data?.run?.run_at;
  const columns: Column<Suggestion>[] = [
    { key: "item", header: "Item", cell: (s) => <span><span className="num block">{s.item_code}</span><span className="block text-xs text-muted-foreground">{items.get(s.item_id)?.name}</span></span> },
    { key: "action", header: "Action", cell: (s) => humanize(s.action) },
    { key: "onhand", header: "On hand", align: "right", cell: (s) => <span className="num">{trim(s.on_hand)}</span> },
    { key: "supply", header: "Open supply", align: "right", cell: (s) => <span className="num">{trim(s.open_supply)}</span> },
    { key: "demand", header: "Demand", align: "right", cell: (s) => <span className="num">{trim(s.demand)}</span> },
    { key: "level", header: "Reorder level", align: "right", cell: (s) => <span className="num">{trim(s.reorder_level)}</span> },
    { key: "qty", header: "Suggested", align: "right", cell: (s) => <span className="num font-semibold">{trim(s.suggested_quantity)} {items.get(s.item_id)?.stock_uom_code}</span> },
    { key: "status", header: "Status", cell: (s) => <DocStatus status={s.status} /> },
  ];
  return (
    <>
      <PageHeader title="Material requirements planning"
        description="Nets stock on hand and open purchase/production supply against approved sales demand, production needs and reorder levels. It only suggests; people raise the requisitions." />
      <div className="grid grid-cols-1 gap-6">
        {can("procurement.mrp.create") && (
          <Section title="Run MRP">
            <form className="flex flex-wrap items-end gap-3 px-5 py-4" onSubmit={(e) => { e.preventDefault(); run.mutate(undefined); }}>
              <Field id="mrp-horizon" label="Horizon (days)"><Input id="mrp-horizon" inputMode="numeric" className="num w-28" value={horizon} onChange={(e) => setHorizon(e.target.value.replace(/\D/g, ""))} /></Field>
              <Button type="submit" disabled={run.isPending}><Play aria-hidden /> {run.isPending ? "Running…" : "Run now"}</Button>
              <ActionError error={run.error} className="basis-full" />
            </form>
          </Section>
        )}
        <Section title="Latest suggestions" description={runAt ? `Run ${dateTime(runAt)}` : "MRP hasn't run yet for this company."}>
          <DataTable columns={columns} rows={rows} isLoading={latest.isLoading} error={latest.error} onRetry={latest.refetch} caption="MRP suggestions"
            empty={<EmptyState icon={Cog} title={runAt ? "Nothing to reorder" : "No MRP run yet"} description={runAt ? "Stock and open supply cover demand and reorder levels." : "Run MRP to see what needs buying or making."} />} />
        </Section>
      </div>
    </>
  );
}
