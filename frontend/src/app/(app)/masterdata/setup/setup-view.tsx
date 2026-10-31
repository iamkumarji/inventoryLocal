"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Search, Tags } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { ActionError, ItemPicker, type ItemOption } from "@/components/inventory/bits";
import { dec, isDecimal } from "@/components/inventory/decimal";
import { bannerError, fieldErrors } from "@/components/inventory/problem";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { useCategories, useUoms, type HsnCode, type ItemCategory, type Uom, type UomConversion } from "@/lib/api/inventory";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const UOM_KINDS = { count: "Count", mass: "Mass", length: "Length", volume: "Volume", area: "Area", time: "Time" };
const NONE = "__none__";

function FormDialog({ open, onOpenChange, title, description, onSubmit, pending, error, denied, children, submitLabel = "Save" }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; onSubmit: () => void; pending: boolean;
  error: unknown; denied: string; children: ReactNode; submitLabel?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <ActionError error={bannerError(error)} denied={denied} />
          {children}
          <DialogFooter><Button type="submit" disabled={pending}>{submitLabel}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Check({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="font-normal">{label}</Label>
    </div>
  );
}

/* ---------------------------------------------------------------- Units of measure */

function UomDialog({ uom, open, onOpenChange }: { uom: Uom | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [seen, setSeen] = useState<Uom | null | undefined>(undefined);
  const [d, setD] = useState({ code: "", name: "", kind: "count", decimals: "0", is_active: true });
  if (open && seen !== uom) {
    setSeen(uom);
    setD(uom ? { code: uom.code, name: uom.name, kind: uom.kind, decimals: String(uom.decimals ?? 3), is_active: uom.is_active ?? true } : { code: "", name: "", kind: "count", decimals: "0", is_active: true });
  }
  const save = useMutation({
    mutationFn: () => uom
      ? unwrap(api.PATCH("/api/v1/masterdata/uoms/{id}/", { params: { path: { id: uom.id } }, body: { name: d.name, decimals: Number(d.decimals), is_active: d.is_active } }))
      : unwrap(api.POST("/api/v1/masterdata/uoms/", { body: { code: d.code.trim(), name: d.name, kind: d.kind as Uom["kind"], decimals: Number(d.decimals) } })),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["masterdata", "uoms"] }); toast("Unit saved"); onOpenChange(false); },
  });
  const e = fieldErrors(save.error);
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={uom ? `Edit ${uom.code}` : "New unit of measure"} onSubmit={() => save.mutate()} pending={save.isPending}
      error={save.error} denied="You can't manage units of measure." description="Decimals sets how precisely quantities in this unit can be entered; 0 means whole units only.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="uom-code" label="Code" error={e.code}><Input id="uom-code" className="num" value={d.code} onChange={(ev) => setD({ ...d, code: ev.target.value.toUpperCase() })} disabled={!!uom} required /></Field>
        <Field id="uom-name" label="Name" error={e.name}><Input id="uom-name" value={d.name} onChange={(ev) => setD({ ...d, name: ev.target.value })} required /></Field>
        <Field id="uom-kind" label="Kind" error={e.kind}>
          <Select value={d.kind} onValueChange={(v) => setD({ ...d, kind: v })} disabled={!!uom}>
            <SelectTrigger id="uom-kind" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(UOM_KINDS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field id="uom-dec" label="Decimals" error={e.decimals}>
          <Select value={d.decimals} onValueChange={(v) => setD({ ...d, decimals: v })}>
            <SelectTrigger id="uom-dec" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{["0", "1", "2", "3", "4", "5", "6"].map((n) => <SelectItem key={n} value={n}>{n === "0" ? "0 (whole units)" : n}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </div>
      {uom && <Check id="uom-active" label="Active" checked={d.is_active} onChange={(v) => setD({ ...d, is_active: v })} />}
    </FormDialog>
  );
}

function Uoms() {
  const { can } = useSession();
  const query = useUoms();
  const [editing, setEditing] = useState<Uom | null>(null);
  const [open, setOpen] = useState(false);
  const columns: Column<Uom>[] = [
    { key: "code", header: "Code", cell: (u) => <span className="num font-medium">{u.code}</span> },
    { key: "name", header: "Name", cell: (u) => u.name },
    { key: "kind", header: "Kind", cell: (u) => UOM_KINDS[u.kind as keyof typeof UOM_KINDS] ?? u.kind },
    { key: "dec", header: "Decimals", align: "right", cell: (u) => <span className="num">{u.decimals ?? 3}</span> },
    { key: "status", header: "Status", cell: (u) => <ActiveStatus active={u.is_active ?? true} /> },
    ...(can("masterdata.uom.update") ? [{ key: "edit", header: <span className="sr-only">Edit</span>, align: "right" as const, cell: (u: Uom) => (
      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${u.code}`} onClick={() => { setEditing(u); setOpen(true); }}><Pencil /></Button>
    ) }] : []),
  ];
  return (
    <Section title="Units of measure" actions={can("masterdata.uom.create") && <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus aria-hidden /> New unit</Button>}>
      <DataTable columns={columns} rows={query.data} isLoading={query.isLoading} error={query.error} onRetry={query.refetch} caption="Units of measure"
        empty={<EmptyState icon={Tags} title="No units yet" description="Create the units you stock and trade in, such as PCS, KG or M." />} />
      <UomDialog uom={editing} open={open} onOpenChange={setOpen} />
    </Section>
  );
}

/* ---------------------------------------------------------------- Conversions */

function ConversionDialog({ conv, open, onOpenChange }: { conv: UomConversion | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const uoms = useUoms();
  const [seen, setSeen] = useState<UomConversion | null | undefined>(undefined);
  const [d, setD] = useState<{ item: ItemOption | null; from_uom: string; to_uom: string; factor: string }>({ item: null, from_uom: "", to_uom: "", factor: "" });
  const [localError, setLocalError] = useState<string | null>(null);
  if (open && seen !== conv) {
    setSeen(conv);
    setD(conv ? { item: null, from_uom: conv.from_uom, to_uom: conv.to_uom, factor: dec.normalize(conv.factor) } : { item: null, from_uom: "", to_uom: "", factor: "" });
  }
  const save = useMutation({
    mutationFn: () => conv
      ? unwrap(api.PATCH("/api/v1/masterdata/uom-conversions/{id}/", { params: { path: { id: conv.id } }, body: { factor: d.factor } }))
      : unwrap(api.POST("/api/v1/masterdata/uom-conversions/", { body: { item: d.item?.id ?? null, from_uom: d.from_uom, to_uom: d.to_uom, factor: d.factor } })),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["masterdata", "conversions"] }); toast("Conversion saved"); onOpenChange(false); },
  });
  const e = fieldErrors(save.error);
  const code = (id: string) => uoms.data?.find((u) => u.id === id)?.code ?? "?";
  const uomSelect = (key: "from_uom" | "to_uom", label: string) => (
    <Field id={`conv-${key}`} label={label} error={e[key]}>
      <Select value={d[key]} onValueChange={(v) => setD({ ...d, [key]: v })} disabled={!!conv}>
        <SelectTrigger id={`conv-${key}`} className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
        <SelectContent>{uoms.data?.map((u) => <SelectItem key={u.id} value={u.id}>{u.code}</SelectItem>)}</SelectContent>
      </Select>
    </Field>
  );
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={conv ? "Edit conversion" : "New conversion"} pending={save.isPending} error={save.error ?? null}
      denied="You can't manage unit conversions."
      description="1 from-unit equals factor × to-unit. Item-specific conversions (1 BAG = 50 KG of cement) override general ones."
      onSubmit={() => {
        const bad = !isDecimal(d.factor) || dec.cmp(d.factor, "0") <= 0 ? "The factor must be a number above zero." : !conv && d.from_uom === d.to_uom ? "Choose two different units." : null;
        setLocalError(bad);
        if (!bad) save.mutate();
      }}>
      {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
      {!conv && (
        <Field id="conv-item" label="Item (optional)" hint="Leave empty for a conversion that applies to every item." error={e.item}>
          <ItemPicker id="conv-item" value={d.item} onChange={(item) => setD({ ...d, item })} placeholder="All items" />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        {uomSelect("from_uom", "From unit")}
        <Field id="conv-factor" label="Factor" error={e.factor}><Input id="conv-factor" inputMode="decimal" className="num" value={d.factor} onChange={(ev) => setD({ ...d, factor: ev.target.value })} required /></Field>
        {uomSelect("to_uom", "To unit")}
      </div>
      {d.from_uom && d.to_uom && isDecimal(d.factor) && <p className="num text-sm text-muted-foreground">1 {code(d.from_uom)} = {dec.normalize(d.factor)} {code(d.to_uom)}</p>}
    </FormDialog>
  );
}

function Conversions() {
  const { can } = useSession();
  const url = useUrlState();
  const uoms = useUoms();
  const [editing, setEditing] = useState<UomConversion | null>(null);
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["masterdata", "conversions", url.page],
    queryFn: () => unwrap(api.GET("/api/v1/masterdata/uom-conversions/", { params: { query: { page: url.page } } })),
  });
  const code = (id: string) => uoms.data?.find((u) => u.id === id)?.code ?? "?";
  const columns: Column<UomConversion>[] = [
    { key: "rule", header: "Conversion", cell: (c) => <span className="num">1 {code(c.from_uom)} = {dec.normalize(c.factor)} {code(c.to_uom)}</span> },
    { key: "item", header: "Applies to", cell: (c) => (c.item ? <ItemCode id={c.item} /> : <span className="text-muted-foreground">All items</span>) },
    ...(can("masterdata.uom.update") ? [{ key: "edit", header: <span className="sr-only">Edit</span>, align: "right" as const, cell: (c: UomConversion) => (
      <Button variant="ghost" size="icon-sm" aria-label={`Edit conversion ${code(c.from_uom)} to ${code(c.to_uom)}`} onClick={() => { setEditing(c); setOpen(true); }}><Pencil /></Button>
    ) }] : []),
  ];
  return (
    <Section title="Unit conversions" actions={can("masterdata.uom.create") && <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus aria-hidden /> New conversion</Button>}>
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch} caption="Unit conversions"
        empty={<EmptyState icon={Tags} title="No conversions yet" description="Needed when you buy or sell in a different unit from the stock unit." />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      <ConversionDialog conv={editing} open={open} onOpenChange={setOpen} />
    </Section>
  );
}

function ItemCode({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["masterdata", "item", id], queryFn: () => unwrap(api.GET("/api/v1/masterdata/items/{id}/", { params: { path: { id } } })), staleTime: 60_000 });
  return <span className="num">{q.data?.code ?? "…"}</span>;
}

/* ---------------------------------------------------------------- Categories */

function CategoryDialog({ cat, open, onOpenChange }: { cat: ItemCategory | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const categories = useCategories();
  const [seen, setSeen] = useState<ItemCategory | null | undefined>(undefined);
  const [d, setD] = useState({ code: "", name: "", parent: "", posting_group: "", is_active: true });
  if (open && seen !== cat) {
    setSeen(cat);
    setD(cat ? { code: cat.code, name: cat.name, parent: cat.parent ?? "", posting_group: cat.posting_group, is_active: cat.is_active ?? true } : { code: "", name: "", parent: "", posting_group: "", is_active: true });
  }
  const save = useMutation({
    mutationFn: () => cat
      ? unwrap(api.PATCH("/api/v1/masterdata/item-categories/{id}/", { params: { path: { id: cat.id } }, body: { name: d.name, parent: d.parent || null, posting_group: d.posting_group.trim(), is_active: d.is_active, version: cat.version } as never }))
      : unwrap(api.POST("/api/v1/masterdata/item-categories/", { body: { code: d.code.trim(), name: d.name, parent: d.parent || null, posting_group: d.posting_group.trim() } })),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["masterdata", "categories"] }); toast("Category saved"); onOpenChange(false); },
    onError: (error) => { if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["masterdata", "categories"] }); },
  });
  const e = fieldErrors(save.error);
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={cat ? `Edit ${cat.code}` : "New item category"} onSubmit={() => save.mutate()} pending={save.isPending}
      error={save.error} denied="You can't manage item categories."
      description="The posting group decides which inventory, cost and variance accounts items in this category post to (for example RM, FG, CONS, SPARE).">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="cat-code" label="Code" error={e.code}><Input id="cat-code" className="num" value={d.code} onChange={(ev) => setD({ ...d, code: ev.target.value.toUpperCase() })} disabled={!!cat} required /></Field>
        <Field id="cat-name" label="Name" error={e.name}><Input id="cat-name" value={d.name} onChange={(ev) => setD({ ...d, name: ev.target.value })} required /></Field>
        <Field id="cat-pg" label="Posting group" error={e.posting_group}><Input id="cat-pg" className="num" value={d.posting_group} onChange={(ev) => setD({ ...d, posting_group: ev.target.value.toUpperCase() })} required /></Field>
        <Field id="cat-parent" label="Parent category" error={e.parent}>
          <Select value={d.parent || NONE} onValueChange={(v) => setD({ ...d, parent: v === NONE ? "" : v })}>
            <SelectTrigger id="cat-parent" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={NONE}>None (top level)</SelectItem>{categories.data?.filter((c) => c.id !== cat?.id).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </div>
      {cat && <Check id="cat-active" label="Active" checked={d.is_active} onChange={(v) => setD({ ...d, is_active: v })} />}
    </FormDialog>
  );
}

function Categories() {
  const { can } = useSession();
  const query = useCategories();
  const [editing, setEditing] = useState<ItemCategory | null>(null);
  const [open, setOpen] = useState(false);
  const name = (id: string | null | undefined) => (id ? query.data?.find((c) => c.id === id)?.name ?? "—" : "—");
  const columns: Column<ItemCategory>[] = [
    { key: "code", header: "Code", cell: (c) => <span className="num font-medium">{c.code}</span> },
    { key: "name", header: "Name", cell: (c) => c.name },
    { key: "pg", header: "Posting group", cell: (c) => <span className="num">{c.posting_group}</span> },
    { key: "parent", header: "Parent", cell: (c) => <span className="text-muted-foreground">{name(c.parent)}</span> },
    { key: "status", header: "Status", cell: (c) => <ActiveStatus active={c.is_active ?? true} /> },
    ...(can("masterdata.item_category.update") ? [{ key: "edit", header: <span className="sr-only">Edit</span>, align: "right" as const, cell: (c: ItemCategory) => (
      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.code}`} onClick={() => { setEditing(c); setOpen(true); }}><Pencil /></Button>
    ) }] : []),
  ];
  return (
    <Section title="Item categories" actions={can("masterdata.item_category.create") && <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus aria-hidden /> New category</Button>}>
      <DataTable columns={columns} rows={query.data} isLoading={query.isLoading} error={query.error} onRetry={query.refetch} caption="Item categories"
        empty={<EmptyState icon={Tags} title="No categories yet" description="Every item needs a category; its posting group drives the accounting." />} />
      <CategoryDialog cat={editing} open={open} onOpenChange={setOpen} />
    </Section>
  );
}

/* ---------------------------------------------------------------- HSN / SAC */

function HsnDialog({ hsn, open, onOpenChange }: { hsn: HsnCode | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [seen, setSeen] = useState<HsnCode | null | undefined>(undefined);
  const [d, setD] = useState({ code: "", description: "", gst_rate: "", is_service: false, is_active: true });
  const [localError, setLocalError] = useState<string | null>(null);
  if (open && seen !== hsn) {
    setSeen(hsn);
    setD(hsn ? { code: hsn.code, description: hsn.description, gst_rate: dec.normalize(hsn.gst_rate), is_service: hsn.is_service ?? false, is_active: hsn.is_active ?? true } : { code: "", description: "", gst_rate: "", is_service: false, is_active: true });
  }
  const save = useMutation({
    mutationFn: () => hsn
      ? unwrap(api.PATCH("/api/v1/masterdata/hsn-codes/{id}/", { params: { path: { id: hsn.id } }, body: { description: d.description, gst_rate: d.gst_rate, is_service: d.is_service, is_active: d.is_active } }))
      : unwrap(api.POST("/api/v1/masterdata/hsn-codes/", { body: { code: d.code.trim(), description: d.description, gst_rate: d.gst_rate, is_service: d.is_service } })),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["masterdata", "hsn"] }); toast("HSN code saved"); onOpenChange(false); },
  });
  const e = fieldErrors(save.error);
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={hsn ? `Edit HSN ${hsn.code}` : "New HSN / SAC code"} pending={save.isPending} error={save.error}
      denied="You can't manage HSN codes. Changing GST rates is a sensitive permission."
      description="GST rates change by notification; update the rate here rather than on each item."
      onSubmit={() => {
        const bad = !hsn && !/^\d{4,8}$/.test(d.code.trim()) ? "HSN/SAC codes are 4 to 8 digits." : !isDecimal(d.gst_rate) || dec.cmp(d.gst_rate, "100") > 0 || dec.isNegative(d.gst_rate) ? "The GST rate must be between 0 and 100." : null;
        setLocalError(bad);
        if (!bad) save.mutate();
      }}>
      {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="hsn-code" label="Code" error={e.code}><Input id="hsn-code" inputMode="numeric" className="num" value={d.code} onChange={(ev) => setD({ ...d, code: ev.target.value.replace(/\D/g, "") })} disabled={!!hsn} required /></Field>
        <Field id="hsn-rate" label="GST rate (%)" error={e.gst_rate}><Input id="hsn-rate" inputMode="decimal" className="num" value={d.gst_rate} onChange={(ev) => setD({ ...d, gst_rate: ev.target.value })} required /></Field>
        <Field id="hsn-desc" label="Description" error={e.description} className="sm:col-span-2"><Input id="hsn-desc" value={d.description} onChange={(ev) => setD({ ...d, description: ev.target.value })} required /></Field>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Check id="hsn-svc" label="Service (SAC)" checked={d.is_service} onChange={(v) => setD({ ...d, is_service: v })} />
        {hsn && <Check id="hsn-active" label="Active" checked={d.is_active} onChange={(v) => setD({ ...d, is_active: v })} />}
      </div>
    </FormDialog>
  );
}

function Hsn() {
  const { can } = useSession();
  const url = useUrlState();
  const search = url.get("q");
  const [draft, setDraft] = useState(search);
  const [editing, setEditing] = useState<HsnCode | null>(null);
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["masterdata", "hsn", search, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/masterdata/hsn-codes/", { params: { query: { search: search || undefined, page: url.page } } })),
  });
  const columns: Column<HsnCode>[] = [
    { key: "code", header: "Code", cell: (h) => <span className="num font-medium">{h.code}</span> },
    { key: "desc", header: "Description", cell: (h) => <span className="block max-w-[44ch] truncate">{h.description}</span> },
    { key: "rate", header: "GST", align: "right", cell: (h) => <span className="num">{dec.normalize(h.gst_rate)}%</span> },
    { key: "kind", header: "Kind", cell: (h) => (h.is_service ? "Service (SAC)" : "Goods") },
    { key: "status", header: "Status", cell: (h) => <ActiveStatus active={h.is_active ?? true} /> },
    ...(can("masterdata.hsn_code.update") ? [{ key: "edit", header: <span className="sr-only">Edit</span>, align: "right" as const, cell: (h: HsnCode) => (
      <Button variant="ghost" size="icon-sm" aria-label={`Edit HSN ${h.code}`} onClick={() => { setEditing(h); setOpen(true); }}><Pencil /></Button>
    ) }] : []),
  ];
  return (
    <Section title="HSN / SAC codes"
      actions={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <form onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }} className="relative w-full sm:w-48">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Code or description" className="h-9 pl-8" aria-label="Search HSN codes" />
          </form>
          {can("masterdata.hsn_code.create") && <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus aria-hidden /> New code</Button>}
        </div>
      }>
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch} caption="HSN and SAC codes"
        empty={<EmptyState icon={Tags} title="No HSN codes match" description="Add the HSN/SAC codes your items use, with their GST rate." />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      <HsnDialog hsn={editing} open={open} onOpenChange={setOpen} />
    </Section>
  );
}

export function SetupView() {
  const url = useUrlState();
  const { can } = useSession();
  const tabs = [
    can("masterdata.uom.read") && (["uoms", "Units"] as const),
    can("masterdata.uom.read") && (["conversions", "Conversions"] as const),
    can("masterdata.item_category.read") && (["categories", "Categories"] as const),
    can("masterdata.hsn_code.read") && (["hsn", "HSN / SAC"] as const),
  ].filter(Boolean) as ReadonlyArray<readonly [string, string]>;
  const tab = url.get("tab") || tabs[0]?.[0] || "uoms";
  return (
    <>
      <PageHeader title="Item setup" description="Units of measure, conversions, item categories and HSN codes shared by every company." />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v, q: null })}>
        <TabsList className="mb-4 max-w-full overflow-x-auto">
          {tabs.map(([k, label]) => <TabsTrigger key={k} value={k}>{label}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="uoms"><Uoms /></TabsContent>
        <TabsContent value="conversions"><Conversions /></TabsContent>
        <TabsContent value="categories"><Categories /></TabsContent>
        <TabsContent value="hsn"><Hsn /></TabsContent>
      </Tabs>
    </>
  );
}
