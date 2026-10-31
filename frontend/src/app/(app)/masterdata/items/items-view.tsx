"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package, Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus, StatusBadge } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { ActionError, ANY, FilterBar } from "@/components/inventory/bits";
import { blankItem, itemBody, ItemFields, type ItemDraft } from "@/components/inventory/item-form";
import { bannerError, fieldErrors } from "@/components/inventory/problem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, unwrap } from "@/lib/api/client";
import { ITEM_TYPES, TRACKING, useCategories, type Item } from "@/lib/api/inventory";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

function NewItem({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ItemDraft>(blankItem);
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/masterdata/items/", { body: itemBody(draft, "create") as never })),
    onSuccess: (item) => {
      queryClient.invalidateQueries({ queryKey: ["masterdata", "items"] });
      toast(`${item.code} created`);
      setDraft(blankItem());
      onOpenChange(false);
      router.push(`/masterdata/items/${item.id}`);
    },
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>New item</SheetTitle>
          <SheetDescription>Items are shared by every company in the organization. Barcodes and warehouse reorder levels are added after creation.</SheetDescription>
        </SheetHeader>
        <form className="grid gap-5 px-4 pb-6" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <ActionError error={bannerError(create.error)} denied="You can't create items." />
          <ItemFields draft={draft} onChange={setDraft} mode="create" errors={fieldErrors(create.error)} />
          <Button type="submit" disabled={create.isPending || !draft.code || !draft.name || !draft.category || !draft.stock_uom}>
            {create.isPending ? "Creating…" : "Create item"}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function ItemsView() {
  const { can } = useSession();
  const url = useUrlState();
  const categories = useCategories();
  const [creating, setCreating] = useState(false);
  const search = url.get("q");
  const [draft, setDraft] = useState(search);
  const type = url.get("type");
  const category = url.get("category");
  const tracking = url.get("tracking");
  const active = url.get("active") || "active";
  const query = useQuery({
    queryKey: ["masterdata", "items", search, type, category, tracking, active, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/masterdata/items/", {
      params: { query: {
        search: search || undefined, item_type: (type || undefined) as never, category: category || undefined, tracking: (tracking || undefined) as never,
        is_active: active === "all" ? undefined : active === "active", page: url.page,
      } },
    })),
  });
  const columns: Column<Item>[] = [
    { key: "code", header: "Item", cell: (i) => <span><span className="num block">{i.code}</span><span className="block max-w-[32ch] truncate text-xs font-normal text-muted-foreground">{i.name}</span></span> },
    { key: "type", header: "Type", cell: (i) => ITEM_TYPES[i.item_type] ?? i.item_type },
    { key: "cat", header: "Category", cell: (i) => i.category_name },
    { key: "uom", header: "Unit", cell: (i) => <span className="num">{i.stock_uom_code}</span> },
    { key: "track", header: "Tracking", cell: (i) => <span className="text-muted-foreground">{TRACKING[i.tracking ?? "none"]}</span> },
    { key: "qc", header: "Quality", cell: (i) => (i.inspection_required ? <StatusBadge tone="pending">Inspected</StatusBadge> : <span className="text-muted-foreground">—</span>) },
    { key: "status", header: "Status", cell: (i) => <ActiveStatus active={i.is_active ?? true} /> },
  ];
  return (
    <>
      <PageHeader title="Items" description="Materials, parts, products and services. Stock, purchasing, production and sales all refer to these."
        actions={can("masterdata.item.create") && <Button onClick={() => setCreating(true)}><Plus aria-hidden /> New item</Button>} />
      <Section
        actions={
          <FilterBar>
            <form onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }} className="relative w-full sm:w-52">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Code, name or barcode" className="h-9 pl-8" aria-label="Search items" />
            </form>
            <Select value={type || ANY} onValueChange={(v) => url.set({ type: v === ANY ? null : v })}>
              <SelectTrigger className="w-full sm:w-40" aria-label="Item type"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ANY}>Any type</SelectItem>{Object.entries(ITEM_TYPES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={category || ANY} onValueChange={(v) => url.set({ category: v === ANY ? null : v })}>
              <SelectTrigger className="w-full sm:w-40" aria-label="Category"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ANY}>Any category</SelectItem>{categories.data?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={tracking || ANY} onValueChange={(v) => url.set({ tracking: v === ANY ? null : v })}>
              <SelectTrigger className="w-full sm:w-36" aria-label="Tracking"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ANY}>Any tracking</SelectItem>{Object.entries(TRACKING).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={active} onValueChange={(v) => url.set({ active: v === "active" ? null : v })}>
              <SelectTrigger className="w-full sm:w-32" aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="inactive">Inactive</SelectItem><SelectItem value="all">All</SelectItem></SelectContent>
            </Select>
          </FilterBar>
        }
      >
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(i) => `/masterdata/items/${i.id}`} caption="Items"
          empty={<EmptyState icon={Package} title="No items match" description="Set up units and categories in Item setup, then create items here." />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
      {can("masterdata.item.create") && <NewItem open={creating} onOpenChange={setCreating} />}
    </>
  );
}
