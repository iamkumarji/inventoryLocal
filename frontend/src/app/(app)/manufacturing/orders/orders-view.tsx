"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Factory, Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ActionDialog } from "@/components/production/action-dialog";
import { ItemPicker, PlaceSelect, type ItemRef } from "@/components/production/pickers";
import { StateBadge } from "@/components/production/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { isDecimal, qty, today, useOrgPlaces, type ProductionOrder } from "@/lib/api/production";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const STATUSES = ["draft", "released", "in_progress", "completed", "closed", "cancelled"] as const;

function NewOrder() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const places = useOrgPlaces();
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState<ItemRef | null>(null);
  const [form, setForm] = useState({ facility: "", quantity: "", planned_start: today(), planned_end: today(), source_warehouse: "", wip_warehouse: "", output_warehouse: "" });
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/manufacturing/orders/", { body: { ...form, item: item!.id, company: places.companyId } })),
    onSuccess: (order) => {
      queryClient.invalidateQueries({ queryKey: ["manufacturing", "orders"] });
      toast("Draft order created. Check material availability, then release it.");
      setOpen(false); // Next keeps the list mounted: don't leave the dialog open behind the new record
      router.push(`/manufacturing/orders/${order.id}`);
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  const valid = item && form.facility && isDecimal(form.quantity, { allowZero: false }) && form.source_warehouse && form.wip_warehouse && form.output_warehouse && form.planned_end >= form.planned_start;
  const setPlace = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });
  return (
    <ActionDialog open={open} onOpenChange={setOpen} trigger={<Button><Plus aria-hidden /> New order</Button>}
      title="New production order" description="The order uses the item's approved BOM version effective on the planned start date."
      submitLabel="Create draft order" pending={create.isPending} error={create.error} disabled={!valid} onSubmit={() => create.mutate()}>
      <Field id="po-item" label="Item to make" error={errors.item}><ItemPicker id="po-item" manufactured value={item} onChange={setItem} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="po-qty" label={`Quantity${item?.stock_uom_code ? ` (${item.stock_uom_code})` : ""}`} error={errors.quantity}>
          <Input id="po-qty" inputMode="decimal" className="num h-10" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} required />
        </Field>
        <Field id="po-facility" label="Facility" error={errors.facility}><PlaceSelect id="po-facility" kind="facility" value={form.facility} onChange={setPlace("facility")} /></Field>
        <Field id="po-start" label="Planned start" error={errors.planned_start}><Input id="po-start" type="date" className="h-10" value={form.planned_start} onChange={(e) => setForm({ ...form, planned_start: e.target.value })} /></Field>
        <Field id="po-end" label="Planned end" error={errors.planned_end}><Input id="po-end" type="date" className="h-10" value={form.planned_end} min={form.planned_start} onChange={(e) => setForm({ ...form, planned_end: e.target.value })} /></Field>
      </div>
      <Field id="po-source" label="Issue materials from" error={errors.source_warehouse}><PlaceSelect id="po-source" kind="warehouse" value={form.source_warehouse} onChange={setPlace("source_warehouse")} /></Field>
      <Field id="po-wip" label="Work-in-progress warehouse" error={errors.wip_warehouse}><PlaceSelect id="po-wip" kind="warehouse" types={["wip"]} value={form.wip_warehouse} onChange={setPlace("wip_warehouse")} /></Field>
      <Field id="po-output" label="Receive output into" error={errors.output_warehouse}><PlaceSelect id="po-output" kind="warehouse" value={form.output_warehouse} onChange={setPlace("output_warehouse")} /></Field>
    </ActionDialog>
  );
}

export function OrdersView() {
  const { can } = useSession();
  const url = useUrlState();
  const places = useOrgPlaces();
  const search = url.get("q");
  const status = url.get("status");
  const [draft, setDraft] = useState(search);
  const query = useQuery({
    queryKey: ["manufacturing", "orders", search, status, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/manufacturing/orders/", {
      params: { query: { search: search || undefined, status: (status || undefined) as ProductionOrder["status"] | undefined, page: url.page } },
    })),
  });
  const columns: Column<ProductionOrder>[] = [
    { key: "number", header: "Order", cell: (o) => <span><span className="num block">{o.number || "Draft"}</span><span className="num block text-xs font-normal text-muted-foreground">{o.item_code}</span></span> },
    { key: "status", header: "Status", cell: (o) => <StateBadge kind="order" value={o.status} /> },
    { key: "qty", header: "Made / ordered", align: "right", cell: (o) => <span className="num">{qty(o.produced_quantity)} / {qty(o.quantity)}</span> },
    { key: "facility", header: "Facility", className: "hidden lg:table-cell", cell: (o) => places.label(o.facility) },
    { key: "start", header: "Planned", className: "hidden md:table-cell", cell: (o) => <span className="text-muted-foreground">{date(o.planned_start)} – {date(o.planned_end)}</span> },
  ];
  return (
    <>
      <PageHeader title="Production orders" description="Release, issue, confirm and receive production on the shop floor; close to freeze the cost."
        actions={can("manufacturing.production_order.create") && <NewOrder />} />
      <Section actions={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <form onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }} className="relative min-w-0 flex-1 sm:flex-none">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Order or item code" className="h-9 w-full pl-8 sm:w-52" aria-label="Search orders" />
          </form>
          <Select value={status || "any"} onValueChange={(v) => url.set({ status: v === "any" ? null : v })}>
            <SelectTrigger className="w-36" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any status</SelectItem>
              {STATUSES.map((s) => <SelectItem key={s} value={s}>{s === "in_progress" ? "In progress" : s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      }>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(o) => `/manufacturing/orders/${o.id}`}
          empty={<EmptyState icon={Factory} title={search || status ? "No order matches" : "No production orders yet"} />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
