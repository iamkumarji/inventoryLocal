"use client";

import { PageHeader, Section } from "@/components/erp/page-header";
import { AsOf, FilterBar } from "@/components/finance/controls";
import { AgeingTable, OpenItemsTable } from "@/components/finance/subledger";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { today } from "@/lib/api/finance";
import { useUrlState } from "@/lib/use-url-state";

export function ReceivablesView() {
  const url = useUrlState();
  const view = url.get("view") || "open";
  const asOf = url.get("as_of") || today();
  return (
    <>
      <PageHeader title="Receivables" description="What customers owe. Credit notes and on-account receipts show as negative items and reduce the balance." />
      <Tabs value={view} onValueChange={(v) => url.set({ view: v === "open" ? null : v })} className="mb-4">
        <TabsList>
          <TabsTrigger value="open">Open items</TabsTrigger>
          <TabsTrigger value="ageing">Ageing</TabsTrigger>
        </TabsList>
      </Tabs>
      {view === "ageing" && <FilterBar><AsOf value={asOf} onChange={(v) => url.set({ as_of: v })} /></FilterBar>}
      <Section title={view === "ageing" ? "Receivables ageing" : "Open receivables"}
        description={view === "ageing" ? "Outstanding by days past due, per customer." : "Oldest due date first."}>
        {view === "ageing" ? <AgeingTable kind="receivable" asOf={asOf} /> : <OpenItemsTable kind="receivable" page={url.page} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
