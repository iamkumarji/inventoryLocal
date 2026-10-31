"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { ActionError, ANY, FilterBar, ItemPicker, WarehouseSelect, type ItemOption } from "@/components/inventory/bits";
import { fieldErrors } from "@/components/inventory/problem";
import { InvStatus } from "@/components/inventory/status";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api/client";
import { todayIso, useWarehouses, type Count } from "@/lib/api/inventory";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const STATUSES = { counting: "Counting", submitted: "Submitted", posted: "Posted", cancelled: "Cancelled" };

function StartCount() {
  const { activeCompany } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ warehouse: "", count_date: todayIso(), blind: true });
  const [items, setItems] = useState<ItemOption[]>([]);
  const start = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/inventory/counts/", {
      body: { company: activeCompany!.id, warehouse: form.warehouse, count_date: form.count_date, blind: form.blind, item_ids: items.length ? items.map((i) => i.id) : undefined },
    })),
    onSuccess: (c) => {
      queryClient.invalidateQueries({ queryKey: ["inventory", "counts"] });
      toast(`Count ${c.number} started with ${(c.lines as unknown[]).length} lines`);
      router.push(`/inventory/counts/${c.id}`);
    },
  });
  const errors = fieldErrors(start.error);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus aria-hidden /> Start count</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Start a stock count</DialogTitle>
            <DialogDescription>Freezes the current unrestricted quantities as the count sheet. Serial-tracked items are counted by serial and aren&apos;t listed.</DialogDescription>
          </DialogHeader>
          <ActionError error={start.error} denied="You can't start counts in this warehouse." />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="cnt-wh" label="Warehouse" error={errors.warehouse}>
              <WarehouseSelect id="cnt-wh" value={form.warehouse} onChange={(v) => setForm({ ...form, warehouse: v })} />
            </Field>
            <Field id="cnt-date" label="Count date" error={errors.count_date}>
              <Input id="cnt-date" type="date" value={form.count_date} onChange={(e) => setForm({ ...form, count_date: e.target.value })} required />
            </Field>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
            <div>
              <Label htmlFor="cnt-blind" className="font-normal">Blind count</Label>
              <p className="text-xs text-muted-foreground">Counters don&apos;t see the system quantity, so they count what&apos;s really there.</p>
            </div>
            <Switch id="cnt-blind" checked={form.blind} onCheckedChange={(v) => setForm({ ...form, blind: v })} />
          </div>
          <Field id="cnt-items" label="Limit to items (optional)" hint="Leave empty to count everything in the warehouse (a full count); pick items for a cycle count.">
            <ItemPicker id="cnt-items" value={null} placeholder="Add an item" onChange={(i) => i && !items.some((x) => x.id === i.id) && setItems([...items, i])} />
          </Field>
          {items.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {items.map((i) => (
                <li key={i.id}>
                  <StatusBadge tone="neutral" className="gap-1 pr-0.5">
                    <span className="num">{i.code}</span>
                    <button type="button" className="rounded-sm p-0.5 hover:bg-background" aria-label={`Remove ${i.code}`} onClick={() => setItems(items.filter((x) => x.id !== i.id))}><X className="size-3" /></button>
                  </StatusBadge>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter><Button type="submit" disabled={start.isPending || !form.warehouse}>Start count</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CountsView() {
  const { can } = useSession();
  const url = useUrlState();
  const wh = useWarehouses({ activeCompanyOnly: false });
  const status = url.get("status");
  const warehouse = url.get("warehouse");
  const query = useQuery({
    queryKey: ["inventory", "counts", status, warehouse, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/inventory/counts/", { params: { query: { status: (status || undefined) as never, warehouse: warehouse || undefined, page: url.page } } })),
  });
  // Only header fields are shown here: count lines are opened on the count page, where blind rules apply.
  const columns: Column<Count>[] = [
    { key: "number", header: "Count", cell: (c) => <span className="num">{c.number}</span> },
    { key: "date", header: "Count date", cell: (c) => <span className="whitespace-nowrap">{date(c.count_date)}</span> },
    { key: "wh", header: "Warehouse", cell: (c) => <span className="num">{wh.label(c.warehouse)}</span> },
    { key: "type", header: "Type", cell: (c) => (c.blind ? "Blind" : "Open") },
    { key: "lines", header: "Lines", align: "right", cell: (c) => <span className="num">{(c.lines as unknown[]).length}</span> },
    { key: "status", header: "Status", cell: (c) => <InvStatus kind="count" status={c.status} /> },
  ];
  return (
    <>
      <PageHeader title="Stock counts" description="Physical counts. One person counts; someone else approves and posts the differences."
        actions={can("inventory.stock_count.create") && <StartCount />} />
      <Section
        actions={
          <FilterBar>
            <Select value={status || ANY} onValueChange={(v) => url.set({ status: v === ANY ? null : v })}>
              <SelectTrigger className="w-full sm:w-36" aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any status</SelectItem>
                {Object.entries(STATUSES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
            <WarehouseSelect value={warehouse} onChange={(v) => url.set({ warehouse: v })} allowAny className="sm:w-48" ariaLabel="Warehouse" />
          </FilterBar>
        }
      >
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(c) => `/inventory/counts/${c.id}`} caption="Stock counts"
          empty={<EmptyState icon={ClipboardList} title="No counts match" description="Start a count to check what's physically on the shelves." />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
