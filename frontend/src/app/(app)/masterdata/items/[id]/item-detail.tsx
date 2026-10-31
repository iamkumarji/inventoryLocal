"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Barcode, Boxes, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus, StatusBadge } from "@/components/erp/status";
import { EmptyState, ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, WarehouseSelect, useSeedOnOpen } from "@/components/inventory/bits";
import { dec, isDecimal, qty } from "@/components/inventory/decimal";
import { draftFromItem, itemBody, ItemFields, NONE, type ItemDraft } from "@/components/inventory/item-form";
import { bannerError, fieldErrors } from "@/components/inventory/problem";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { ITEM_TYPES, useItemHasHistory, useUoms, useWarehouses, type Item, type ItemPolicy } from "@/lib/api/inventory";
import { useSession } from "@/lib/session";

const decInput = (v: string | null | undefined) => (v ? dec.normalize(v) : "0");
const SYMBOLOGIES = { code128: "Code 128", ean13: "EAN-13", qr: "QR code", gs1_128: "GS1-128" };

function Barcodes({ item }: { item: Item }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const uoms = useUoms();
  const [form, setForm] = useState({ barcode: "", symbology: "code128", uom: "" });
  const add = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/masterdata/items/{id}/barcodes/", {
      params: { path: { id: item.id } }, body: { barcode: form.barcode.trim(), symbology: form.symbology as never, uom: form.uom || null },
    })),
    onSuccess: (updated) => {
      queryClient.setQueryData(["masterdata", "item", item.id], updated);
      setForm({ barcode: "", symbology: form.symbology, uom: "" });
      toast("Barcode added");
    },
  });
  const uomCode = (id: string | null | undefined) => (id ? uoms.data?.find((u) => u.id === id)?.code ?? "—" : item.stock_uom_code);
  return (
    <Section title="Barcodes" description="Scanning any of these finds the item. A barcode can stand for a pack in another unit.">
      {item.barcodes.length === 0 ? <EmptyState icon={Barcode} title="No barcodes yet" /> : (
        <ul className="divide-y">
          {item.barcodes.map((b) => (
            <li key={b.id} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-2.5 text-sm">
              <span className="num font-medium">{b.barcode}</span>
              <span className="text-muted-foreground">{SYMBOLOGIES[(b.symbology ?? "code128") as keyof typeof SYMBOLOGIES]}, unit <span className="num">{uomCode(b.uom)}</span></span>
            </li>
          ))}
        </ul>
      )}
      {can("masterdata.item.update") && (
        <form className="grid gap-3 border-t px-5 py-4 sm:grid-cols-2 sm:items-end" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field id="bc-code" label="Barcode" error={fieldErrors(add.error).barcode} className="sm:col-span-2">
            <Input id="bc-code" className="num" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} required />
          </Field>
          <Field id="bc-sym" label="Symbology">
            <Select value={form.symbology} onValueChange={(v) => setForm({ ...form, symbology: v })}>
              <SelectTrigger id="bc-sym" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(SYMBOLOGIES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="bc-uom" label="Unit">
            <Select value={form.uom || NONE} onValueChange={(v) => setForm({ ...form, uom: v === NONE ? "" : v })}>
              <SelectTrigger id="bc-uom" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>Stock unit</SelectItem>{uoms.data?.filter((u) => u.is_active !== false).map((u) => <SelectItem key={u.id} value={u.id}>{u.code}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Button type="submit" variant="outline" className="justify-self-start sm:col-span-2" disabled={add.isPending || !form.barcode.trim()}><Plus aria-hidden /> Add barcode</Button>
          <ActionError error={bannerError(add.error)} className="sm:col-span-2" denied="You can't change this item." />
        </form>
      )}
    </Section>
  );
}

type PolicyDraft = { warehouse: string; reorder_level: string; reorder_quantity: string; min_quantity: string; max_quantity: string; lead_time_days: string };

function PolicyDialog({ item, policy, open, onOpenChange }: { item: Item; policy: ItemPolicy | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { activeCompany } = useSession();
  const queryClient = useQueryClient();
  const [d, setD] = useState<PolicyDraft>({ warehouse: "", reorder_level: "0", reorder_quantity: "0", min_quantity: "0", max_quantity: "", lead_time_days: "0" });
  const [localError, setLocalError] = useState<string | null>(null);
  const numbers = { reorder_level: d.reorder_level, reorder_quantity: d.reorder_quantity, min_quantity: d.min_quantity, max_quantity: d.max_quantity || null, lead_time_days: Number.parseInt(d.lead_time_days || "0", 10) };
  const save = useMutation({
    mutationFn: () => policy
      ? unwrap(api.PATCH("/api/v1/masterdata/item-policies/{id}/", { params: { path: { id: policy.id } }, body: { ...numbers, version: policy.version } as never }))
      : unwrap(api.POST("/api/v1/masterdata/item-policies/", { body: { ...numbers, company: activeCompany!.id, item: item.id, warehouse: d.warehouse } })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["masterdata", "policies", item.id] });
      toast("Reorder settings saved");
      onOpenChange(false);
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["masterdata", "policies", item.id] });
    },
  });
  useSeedOnOpen(open, policy, () => {
    setD(policy ? {
      warehouse: policy.warehouse, reorder_level: decInput(policy.reorder_level), reorder_quantity: decInput(policy.reorder_quantity),
      min_quantity: decInput(policy.min_quantity), max_quantity: policy.max_quantity ? decInput(policy.max_quantity) : "", lead_time_days: String(policy.lead_time_days ?? 0),
    } : { warehouse: "", reorder_level: "0", reorder_quantity: "0", min_quantity: "0", max_quantity: "", lead_time_days: "0" });
    setLocalError(null);
  }, save.reset);
  const errors = fieldErrors(save.error);
  const num = (k: keyof PolicyDraft, label: string, hint?: string) => (
    <Field id={`pol-${k}`} label={label} error={errors[k]} hint={hint}>
      <Input id={`pol-${k}`} inputMode="decimal" className="num" value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} />
    </Field>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => {
          e.preventDefault();
          const bad = (["reorder_level", "reorder_quantity", "min_quantity"] as const).find((k) => !isDecimal(d[k])) ?? (d.max_quantity && !isDecimal(d.max_quantity) ? "max_quantity" : null);
          setLocalError(bad ? "Quantities must be numbers." : null);
          if (!bad) save.mutate();
        }}>
          <DialogHeader>
            <DialogTitle>{policy ? "Edit reorder settings" : "Add reorder settings"}</DialogTitle>
            <DialogDescription>Planning uses these to suggest purchases when stock falls to the reorder level. Quantities in {item.stock_uom_code}.</DialogDescription>
          </DialogHeader>
          {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
          <ActionError error={bannerError(save.error)} denied="You can't change planning settings for this warehouse." />
          <Field id="pol-wh" label="Warehouse" error={errors.warehouse}>
            <WarehouseSelect id="pol-wh" value={d.warehouse} onChange={(v) => setD({ ...d, warehouse: v })} disabled={!!policy} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            {num("reorder_level", "Reorder level")}
            {num("reorder_quantity", "Reorder quantity")}
            {num("min_quantity", "Minimum")}
            {num("max_quantity", "Maximum", "Blank for no maximum")}
            <Field id="pol-lead" label="Lead time (days)" error={errors.lead_time_days}>
              <Input id="pol-lead" inputMode="numeric" className="num" value={d.lead_time_days} onChange={(e) => setD({ ...d, lead_time_days: e.target.value.replace(/\D/g, "") })} />
            </Field>
          </div>
          <DialogFooter><Button type="submit" disabled={save.isPending || !d.warehouse}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Policies({ item }: { item: Item }) {
  const { can } = useSession();
  const wh = useWarehouses({ activeCompanyOnly: false });
  const [editing, setEditing] = useState<ItemPolicy | null>(null);
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["masterdata", "policies", item.id],
    queryFn: () => unwrap(api.GET("/api/v1/masterdata/item-policies/", { params: { query: { item: item.id, page_size: 200 } } })),
  });
  const u = item.stock_uom_code;
  const columns: Column<ItemPolicy>[] = [
    { key: "wh", header: "Warehouse", cell: (p) => <span className="num">{wh.label(p.warehouse)}</span> },
    { key: "rl", header: "Reorder level", align: "right", cell: (p) => <span className="num">{qty(p.reorder_level)}</span> },
    { key: "rq", header: "Reorder qty", align: "right", cell: (p) => <span className="num">{qty(p.reorder_quantity)}</span> },
    { key: "mm", header: "Min / max", align: "right", cell: (p) => <span className="num">{qty(p.min_quantity)} / {p.max_quantity ? qty(p.max_quantity) : "—"}</span> },
    { key: "lt", header: "Lead time", align: "right", cell: (p) => <span className="num">{p.lead_time_days ?? 0} d</span> },
    ...(can("masterdata.item_policy.update") ? [{ key: "edit", header: <span className="sr-only">Edit</span>, align: "right" as const, cell: (p: ItemPolicy) => (
      <Button variant="ghost" size="icon-sm" aria-label={`Edit reorder settings for ${wh.label(p.warehouse)}`} onClick={() => { setEditing(p); setOpen(true); }}><Pencil /></Button>
    ) }] : []),
  ];
  return (
    <Section title="Reorder settings by warehouse" description={`Reorder level and quantity, min/max and lead time per warehouse. Quantities in ${u}.`}
      actions={can("masterdata.item_policy.create") && <Button size="sm" variant="outline" onClick={() => { setEditing(null); setOpen(true); }}><Plus aria-hidden /> Add warehouse</Button>}>
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch} caption="Reorder settings"
        empty={<EmptyState title="No reorder settings" description="Without them, planning won't suggest replenishment for this item." />} />
      <PolicyDialog item={item} policy={editing} open={open} onOpenChange={setOpen} />
    </Section>
  );
}

export function ItemDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["masterdata", "item", id], queryFn: () => unwrap(api.GET("/api/v1/masterdata/items/{id}/", { params: { path: { id } } })) });
  const history = useItemHasHistory(id, can("inventory.stock_ledger.read"));
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [syncedVersion, setSyncedVersion] = useState<number | null>(null);
  if (query.data && query.data.version !== syncedVersion) {
    setSyncedVersion(query.data.version);
    setDraft(draftFromItem(query.data));
  }
  const save = useMutation({
    mutationFn: () => {
      const item = query.data!;
      const body: Record<string, unknown> = { ...itemBody(draft!, "edit"), version: item.version };
      // Only send stock unit / tracking when they change: the API refuses changes once there is stock history.
      if (body.stock_uom === item.stock_uom) delete body.stock_uom;
      if (body.tracking === (item.tracking ?? "none")) delete body.tracking;
      return unwrap(api.PATCH("/api/v1/masterdata/items/{id}/", { params: { path: { id } }, body: body as never }));
    },
    onSuccess: (item) => {
      queryClient.setQueryData(["masterdata", "item", id], item);
      queryClient.invalidateQueries({ queryKey: ["masterdata", "items"] });
      toast("Item saved");
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) query.refetch();
    },
  });

  if (query.isLoading || !draft) return query.error ? <ErrorState error={query.error} onRetry={query.refetch} /> : <PageSkeleton />;
  const item = query.data!;
  const editable = can("masterdata.item.update");
  const locked = history.data === true;
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Items", href: "/masterdata/items" }, { label: item.code }]}
        title={<><span className="num">{item.code}</span> <span className="font-semibold text-muted-foreground">{item.name}</span></>}
        meta={<>
          <ActiveStatus active={item.is_active ?? true} />
          <span>{ITEM_TYPES[item.item_type]}</span>
          <span className="text-muted-foreground">{item.category_name}</span>
          {item.inspection_required && <StatusBadge tone="pending">Inspected on receipt</StatusBadge>}
          {locked && <StatusBadge tone="info">Has stock history</StatusBadge>}
        </>}
        actions={can("inventory.stock_balance.read") && <Button variant="outline" asChild><Link href={`/inventory/stock?item=${item.id}`}><Boxes aria-hidden /> Stock</Link></Button>}
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Section title="Item" className="min-w-0 self-start">
          <form className="grid gap-5 px-5 py-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <ItemFields draft={draft} onChange={setDraft} mode="edit" errors={fieldErrors(save.error)} locked={locked} disabled={!editable} />
            <ActionError error={bannerError(save.error)} denied="You can't change items." />
            {editable && <Button type="submit" className="justify-self-start" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save item"}</Button>}
          </form>
        </Section>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6">
          <Barcodes item={item} />
          {can("masterdata.item_policy.read") && <Policies item={item} />}
        </div>
      </div>
    </>
  );
}
