"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Pencil, Plus, Search, Tags } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { ActionDialog } from "@/components/production/action-dialog";
import { PersonField, PlaceSelect } from "@/components/production/pickers";
import { StateBadge } from "@/components/production/status";
import type { Person } from "@/components/erp/person-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { isDecimal, qty, today, useOrgPlaces, type Asset, type AssetCategory } from "@/lib/api/production";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const ASSET_STATUSES = ["draft", "submitted", "rejected", "capitalized", "disposed"] as const;
const METHOD_LABEL = { slm: "Straight line", wdv: "Written down value" } as const;

export function useCategories(enabled = true) {
  return useQuery({
    queryKey: ["assets", "categories", "all"],
    queryFn: () => unwrap(api.GET("/api/v1/assets/categories/", { params: { query: { page_size: 200 } } })),
    enabled,
  });
}

function NewAsset() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const places = useOrgPlaces();
  const [open, setOpen] = useState(false);
  const categories = useCategories(open);
  const [custodian, setCustodian] = useState<Person | null>(null);
  const [form, setForm] = useState({ code: "", name: "", category: "", facility: "", serial_number: "", location: "", acquisition_date: today(), put_to_use_date: today(), cost: "" });
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/assets/assets/", {
      body: { ...form, put_to_use_date: form.put_to_use_date || null, custodian: custodian?.id ?? null, company: places.companyId },
    })),
    onSuccess: (asset) => {
      queryClient.invalidateQueries({ queryKey: ["assets", "register"] });
      toast(`${asset.code} added as a draft`);
      router.push(`/assets/${asset.id}`);
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  const valid = form.code && form.name && form.category && form.facility && isDecimal(form.cost, { maxDp: 4, allowZero: false });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const active = (categories.data?.results ?? []).filter((c) => c.is_active !== false);
  return (
    <ActionDialog open={open} onOpenChange={setOpen} trigger={<Button><Plus aria-hidden /> New asset</Button>}
      title="New fixed asset" description="Depreciation terms are copied from the category. The asset stays a draft until it is capitalized."
      submitLabel="Add asset" pending={create.isPending} error={create.error} disabled={!valid} onSubmit={() => create.mutate()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="a-code" label="Asset code" error={errors.code}><Input id="a-code" className="num h-10" value={form.code} onChange={set("code")} required /></Field>
        <Field id="a-name" label="Name" error={errors.name}><Input id="a-name" className="h-10" value={form.name} onChange={set("name")} required /></Field>
        <Field id="a-category" label="Category" error={errors.category}>
          <Select value={form.category} onValueChange={(category) => setForm({ ...form, category })}>
            <SelectTrigger id="a-category" className="h-10 w-full"><SelectValue placeholder={active.length ? "Choose" : "Create a category first"} /></SelectTrigger>
            <SelectContent>{active.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} · {c.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field id="a-facility" label="Facility" error={errors.facility}><PlaceSelect id="a-facility" kind="facility" value={form.facility} onChange={(facility) => setForm({ ...form, facility })} /></Field>
        <Field id="a-cost" label="Cost (₹)" error={errors.cost}><Input id="a-cost" inputMode="decimal" className="num h-10" value={form.cost} onChange={set("cost")} required /></Field>
        <Field id="a-serial" label="Serial number" error={errors.serial_number}><Input id="a-serial" className="h-10" value={form.serial_number} onChange={set("serial_number")} /></Field>
        <Field id="a-acquired" label="Acquired on" error={errors.acquisition_date}><Input id="a-acquired" type="date" className="h-10" value={form.acquisition_date} onChange={set("acquisition_date")} /></Field>
        <Field id="a-put-to-use" label="Put to use on" error={errors.put_to_use_date} hint="Needed before capitalizing."><Input id="a-put-to-use" type="date" className="h-10" value={form.put_to_use_date} onChange={set("put_to_use_date")} /></Field>
      </div>
      <Field id="a-location" label="Location" error={errors.location}><Input id="a-location" className="h-10" value={form.location} onChange={set("location")} /></Field>
      <Field id="a-custodian" label="Custodian" error={errors.custodian}><PersonField id="a-custodian" value={custodian} onChange={setCustodian} /></Field>
    </ActionDialog>
  );
}

type CategoryForm = { code: string; name: string; depreciation_method: "slm" | "wdv"; useful_life_months: string; wdv_rate: string; salvage_pct: string; is_active: boolean };
type PatchedCategory = components["schemas"]["PatchedAssetCategoryRequest"];

function CategoryDialog({ existing, open, onOpenChange }: { existing: AssetCategory | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { companyId } = useOrgPlaces();
  const [form, setForm] = useState<CategoryForm>({ code: "", name: "", depreciation_method: "slm", useful_life_months: "60", wdv_rate: "0", salvage_pct: "5", is_active: true });
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const marker = open ? (existing?.id ?? null) : undefined;
  if (marker !== loadedFor) {
    setLoadedFor(marker);
    if (open) setForm(existing ? {
      code: existing.code, name: existing.name, depreciation_method: existing.depreciation_method,
      useful_life_months: String(existing.useful_life_months ?? 0), wdv_rate: existing.wdv_rate ?? "0", salvage_pct: existing.salvage_pct ?? "0", is_active: existing.is_active ?? true,
    } : { code: "", name: "", depreciation_method: "slm", useful_life_months: "60", wdv_rate: "0", salvage_pct: "5", is_active: true });
  }
  const save = useMutation({
    mutationFn: () => {
      const body = { name: form.name, depreciation_method: form.depreciation_method, useful_life_months: Number(form.useful_life_months || 0), wdv_rate: form.wdv_rate || "0", salvage_pct: form.salvage_pct || "0", is_active: form.is_active };
      return existing
        ? unwrap(api.PATCH("/api/v1/assets/categories/{id}/", { params: { path: { id: existing.id } }, body: { ...body, version: existing.version } as PatchedCategory }))
        : unwrap(api.POST("/api/v1/assets/categories/", { body: { ...body, code: form.code, company: companyId } }));
    },
    onSuccess: (c) => {
      queryClient.invalidateQueries({ queryKey: ["assets", "categories"] });
      toast(`${c.code} saved`);
      onOpenChange(false);
    },
    onError: () => queryClient.invalidateQueries({ queryKey: ["assets", "categories"] }),
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  const valid = form.name && (existing || form.code) && /^\d+$/.test(form.useful_life_months || "0") && isDecimal(form.wdv_rate || "0", { maxDp: 4 }) && isDecimal(form.salvage_pct || "0", { maxDp: 4 });
  return (
    <ActionDialog open={open} onOpenChange={onOpenChange} title={existing ? `Edit ${existing.code}` : "New asset category"}
      description="Companies Act depreciation terms. Postings use the company's posting rules unless accounts are overridden in finance setup."
      submitLabel={existing ? "Save" : "Create category"} pending={save.isPending} error={save.error} disabled={!valid} onSubmit={() => save.mutate()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="cat-code" label="Code" error={errors.code}><Input id="cat-code" className="num h-10" value={form.code} disabled={!!existing} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
        <Field id="cat-name" label="Name" error={errors.name}><Input id="cat-name" className="h-10" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field id="cat-method" label="Method" error={errors.depreciation_method}>
          <Select value={form.depreciation_method} onValueChange={(v) => setForm({ ...form, depreciation_method: v as CategoryForm["depreciation_method"] })}>
            <SelectTrigger id="cat-method" className="h-10 w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="slm">Straight line</SelectItem><SelectItem value="wdv">Written down value</SelectItem></SelectContent>
          </Select>
        </Field>
        {form.depreciation_method === "slm"
          ? <Field id="cat-life" label="Useful life (months)" error={errors.useful_life_months}><Input id="cat-life" inputMode="numeric" className="num h-10" value={form.useful_life_months} onChange={(e) => setForm({ ...form, useful_life_months: e.target.value })} /></Field>
          : <Field id="cat-rate" label="WDV rate (% a year)" error={errors.wdv_rate}><Input id="cat-rate" inputMode="decimal" className="num h-10" value={form.wdv_rate} onChange={(e) => setForm({ ...form, wdv_rate: e.target.value })} /></Field>}
        <Field id="cat-salvage" label="Salvage (% of cost)" error={errors.salvage_pct}><Input id="cat-salvage" inputMode="decimal" className="num h-10" value={form.salvage_pct} onChange={(e) => setForm({ ...form, salvage_pct: e.target.value })} /></Field>
      </div>
      <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
        <Label htmlFor="cat-active" className="font-normal">Active</Label>
        <Switch id="cat-active" checked={form.is_active} onCheckedChange={(is_active) => setForm({ ...form, is_active })} />
      </div>
    </ActionDialog>
  );
}

function Categories() {
  const { can } = useSession();
  const query = useCategories();
  const [editing, setEditing] = useState<AssetCategory | null>(null);
  const [open, setOpen] = useState(false);
  const columns: Column<AssetCategory>[] = [
    { key: "code", header: "Category", cell: (c) => <span><span className="num block font-medium">{c.code}</span><span className="block text-xs text-muted-foreground">{c.name}</span></span> },
    { key: "method", header: "Method", cell: (c) => METHOD_LABEL[c.depreciation_method] },
    { key: "terms", header: "Terms", cell: (c) => <span className="num">{c.depreciation_method === "slm" ? `${c.useful_life_months} months` : `${qty(c.wdv_rate)}% a year`}</span> },
    { key: "salvage", header: "Salvage", align: "right", className: "hidden sm:table-cell", cell: (c) => <span className="num">{qty(c.salvage_pct)}%</span> },
    { key: "active", header: "Status", className: "hidden sm:table-cell", cell: (c) => <ActiveStatus active={c.is_active ?? true} /> },
    ...(can("assets.asset_category.update") ? [{
      key: "edit", header: <span className="sr-only">Edit</span>, align: "right" as const,
      cell: (c: AssetCategory) => <Button variant="ghost" size="icon" aria-label={`Edit ${c.code}`} onClick={() => { setEditing(c); setOpen(true); }}><Pencil aria-hidden /></Button>,
    }] : []),
  ];
  return (
    <Section title="Categories" actions={can("assets.asset_category.create") && <Button variant="outline" onClick={() => { setEditing(null); setOpen(true); }}><Plus aria-hidden /> New category</Button>}>
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
        empty={<EmptyState icon={Tags} title="No categories yet" description="Categories carry the depreciation method, life and salvage for their assets." />} />
      <CategoryDialog existing={editing} open={open} onOpenChange={setOpen} />
    </Section>
  );
}

function Register() {
  const url = useUrlState();
  const places = useOrgPlaces();
  const search = url.get("q");
  const status = url.get("status");
  const [draft, setDraft] = useState(search);
  const query = useQuery({
    queryKey: ["assets", "register", search, status, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/assets/assets/", {
      params: { query: { search: search || undefined, status: (status || undefined) as Asset["status"] | undefined, page: url.page } },
    })),
  });
  const columns: Column<Asset>[] = [
    { key: "code", header: "Asset", cell: (a) => <span><span className="num block">{a.code}</span><span className="block max-w-[28ch] truncate text-xs font-normal text-muted-foreground">{a.name}</span></span> },
    { key: "status", header: "Status", cell: (a) => <StateBadge kind="asset" value={a.status} /> },
    { key: "cost", header: "Cost", align: "right", className: "hidden sm:table-cell", cell: (a) => <span className="num">{money(a.cost)}</span> },
    { key: "book", header: "Book value", align: "right", cell: (a) => <span className="num">{money(a.book_value)}</span> },
    { key: "category", header: "Category", className: "hidden md:table-cell", cell: (a) => <span className="num">{a.category_code}</span> },
    { key: "facility", header: "Facility", className: "hidden lg:table-cell", cell: (a) => places.label(a.facility) },
  ];
  return (
    <Section actions={
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <form onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }} className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Code, name or serial" className="h-9 w-full pl-8 sm:w-52" aria-label="Search assets" />
        </form>
        <Select value={status || "any"} onValueChange={(v) => url.set({ status: v === "any" ? null : v })}>
          <SelectTrigger className="w-36" aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any status</SelectItem>
            {ASSET_STATUSES.map((s) => <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    }>
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
        rowHref={(a) => `/assets/${a.id}`} empty={<EmptyState icon={Building2} title={search || status ? "No asset matches" : "No assets yet"} />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
    </Section>
  );
}

export function AssetsView() {
  const { can } = useSession();
  const url = useUrlState();
  const tab = url.get("tab") || "register";
  return (
    <>
      <PageHeader title="Fixed assets" description="Asset register: capitalize, depreciate, maintain and dispose."
        actions={tab === "register" && can("assets.asset.create") && <NewAsset />} />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "register" ? null : v, q: null, status: null })} className="mb-4">
        <TabsList>
          <TabsTrigger value="register">Register</TabsTrigger>
          {can("assets.asset_category.read") && <TabsTrigger value="categories">Categories</TabsTrigger>}
        </TabsList>
      </Tabs>
      {tab === "categories" ? <Categories /> : <Register />}
    </>
  );
}
