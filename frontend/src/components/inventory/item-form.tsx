"use client";

import { Lock } from "lucide-react";

import { Field } from "@/components/erp/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ITEM_TYPES, TRACKING, useCategories, useHsnCodes, useUoms, type Item } from "@/lib/api/inventory";

export type ItemDraft = {
  code: string; name: string; description: string; item_type: string; category: string; stock_uom: string;
  purchase_uom: string; sales_uom: string; tracking: string; shelf_life_days: string; hsn: string;
  is_stocked: boolean; is_purchasable: boolean; is_saleable: boolean; is_manufactured: boolean; inspection_required: boolean;
  standard_cost: string; is_active: boolean;
};

export const NONE = "__none__";

export function blankItem(): ItemDraft {
  return {
    code: "", name: "", description: "", item_type: "raw_material", category: "", stock_uom: "", purchase_uom: "", sales_uom: "",
    tracking: "none", shelf_life_days: "", hsn: "", is_stocked: true, is_purchasable: true, is_saleable: false, is_manufactured: false,
    inspection_required: false, standard_cost: "0", is_active: true,
  };
}

export function draftFromItem(i: Item): ItemDraft {
  return {
    code: i.code, name: i.name, description: i.description ?? "", item_type: i.item_type, category: i.category, stock_uom: i.stock_uom,
    purchase_uom: i.purchase_uom ?? "", sales_uom: i.sales_uom ?? "", tracking: i.tracking ?? "none",
    shelf_life_days: i.shelf_life_days === null || i.shelf_life_days === undefined ? "" : String(i.shelf_life_days), hsn: i.hsn ?? "",
    is_stocked: i.is_stocked ?? true, is_purchasable: i.is_purchasable ?? true, is_saleable: i.is_saleable ?? false,
    is_manufactured: i.is_manufactured ?? false, inspection_required: i.inspection_required ?? false,
    standard_cost: i.standard_cost ?? "0", is_active: i.is_active ?? true,
  };
}

/** Request body from the draft (code only on create; the API refuses code changes). */
export function itemBody(d: ItemDraft, mode: "create" | "edit") {
  const body = {
    name: d.name.trim(), description: d.description, item_type: d.item_type as Item["item_type"], category: d.category, stock_uom: d.stock_uom,
    purchase_uom: d.purchase_uom || null, sales_uom: d.sales_uom || null, tracking: d.tracking as NonNullable<Item["tracking"]>,
    shelf_life_days: d.shelf_life_days ? Number.parseInt(d.shelf_life_days, 10) : null, hsn: d.hsn || null,
    is_stocked: d.item_type === "service" ? false : d.is_stocked, is_purchasable: d.is_purchasable, is_saleable: d.is_saleable,
    is_manufactured: d.is_manufactured, inspection_required: d.inspection_required, standard_cost: d.standard_cost || "0", is_active: d.is_active,
  };
  return mode === "create" ? { ...body, code: d.code.trim() } : body;
}

export function ItemFields({ draft, onChange, mode, errors, locked, disabled }: {
  draft: ItemDraft;
  onChange: (d: ItemDraft) => void;
  mode: "create" | "edit";
  errors: Record<string, string>;
  /** Stock UoM and tracking can't change once the item has stock history. */
  locked?: boolean;
  disabled?: boolean;
}) {
  const uoms = useUoms();
  const categories = useCategories();
  const hsn = useHsnCodes();
  const set = <K extends keyof ItemDraft>(k: K, v: ItemDraft[K]) => onChange({ ...draft, [k]: v });
  const activeUoms = (uoms.data ?? []).filter((u) => u.is_active !== false || u.id === draft.stock_uom);
  const lockHint = locked ? <span className="inline-flex items-center gap-1"><Lock className="size-3" aria-hidden /> Fixed: the item has stock history</span> : undefined;
  const flags: Array<[keyof ItemDraft, string]> = [
    ["is_stocked", "Kept in stock"], ["is_purchasable", "Can be purchased"], ["is_saleable", "Can be sold"],
    ["is_manufactured", "Made in-house"], ["inspection_required", "Inspect on receipt / output"],
    ...(mode === "edit" ? ([["is_active", "Active"]] as Array<[keyof ItemDraft, string]>) : []),
  ];
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="it-code" label="Item code" error={errors.code} hint={mode === "edit" ? "Codes can't change after creation." : "Unique across the organization."}>
          <Input id="it-code" className="num" value={draft.code} onChange={(e) => set("code", e.target.value)} disabled={mode === "edit" || disabled} required />
        </Field>
        <Field id="it-name" label="Name" error={errors.name}>
          <Input id="it-name" value={draft.name} onChange={(e) => set("name", e.target.value)} disabled={disabled} required />
        </Field>
        <Field id="it-type" label="Item type" error={errors.item_type}>
          <Select value={draft.item_type} onValueChange={(v) => set("item_type", v)} disabled={disabled}>
            <SelectTrigger id="it-type" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(ITEM_TYPES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field id="it-cat" label="Category" error={errors.category} hint="Decides which accounts stock posts to.">
          <Select value={draft.category} onValueChange={(v) => set("category", v)} disabled={disabled}>
            <SelectTrigger id="it-cat" className="w-full"><SelectValue placeholder={categories.data?.length === 0 ? "Create a category in Item setup" : "Choose"} /></SelectTrigger>
            <SelectContent>{categories.data?.filter((c) => c.is_active !== false || c.id === draft.category).map((c) => <SelectItem key={c.id} value={c.id}>{c.name} <span className="text-muted-foreground">({c.posting_group})</span></SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field id="it-uom" label="Stock unit" error={errors.stock_uom} hint={lockHint}>
          <Select value={draft.stock_uom} onValueChange={(v) => set("stock_uom", v)} disabled={disabled || locked}>
            <SelectTrigger id="it-uom" className="w-full"><SelectValue placeholder={uoms.data?.length === 0 ? "Create a unit in Item setup" : "Choose"} /></SelectTrigger>
            <SelectContent>{activeUoms.map((u) => <SelectItem key={u.id} value={u.id}>{u.code} <span className="text-muted-foreground">{u.name}</span></SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field id="it-track" label="Tracking" error={errors.tracking} hint={lockHint}>
          <Select value={draft.tracking} onValueChange={(v) => set("tracking", v)} disabled={disabled || locked}>
            <SelectTrigger id="it-track" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(TRACKING).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field id="it-puom" label="Purchase unit" error={errors.purchase_uom} hint="Needs a conversion to the stock unit.">
          <Select value={draft.purchase_uom || NONE} onValueChange={(v) => set("purchase_uom", v === NONE ? "" : v)} disabled={disabled}>
            <SelectTrigger id="it-puom" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={NONE}>Same as stock unit</SelectItem>{activeUoms.map((u) => <SelectItem key={u.id} value={u.id}>{u.code}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field id="it-suom" label="Sales unit" error={errors.sales_uom}>
          <Select value={draft.sales_uom || NONE} onValueChange={(v) => set("sales_uom", v === NONE ? "" : v)} disabled={disabled}>
            <SelectTrigger id="it-suom" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={NONE}>Same as stock unit</SelectItem>{activeUoms.map((u) => <SelectItem key={u.id} value={u.id}>{u.code}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field id="it-hsn" label="HSN / SAC code" error={errors.hsn}>
          <Select value={draft.hsn || NONE} onValueChange={(v) => set("hsn", v === NONE ? "" : v)} disabled={disabled}>
            <SelectTrigger id="it-hsn" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={NONE}>None</SelectItem>{hsn.data?.results.filter((h) => h.is_active !== false || h.id === draft.hsn).map((h) => <SelectItem key={h.id} value={h.id}><span className="num">{h.code}</span> <span className="text-muted-foreground">{h.gst_rate}% GST</span></SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field id="it-cost" label="Standard cost (₹)" error={errors.standard_cost}>
            <Input id="it-cost" inputMode="decimal" className="num" value={draft.standard_cost} onChange={(e) => set("standard_cost", e.target.value)} disabled={disabled} />
          </Field>
          <Field id="it-shelf" label="Shelf life (days)" error={errors.shelf_life_days}>
            <Input id="it-shelf" inputMode="numeric" className="num" value={draft.shelf_life_days} onChange={(e) => set("shelf_life_days", e.target.value.replace(/\D/g, ""))} disabled={disabled} />
          </Field>
        </div>
        <Field id="it-desc" label="Description" error={errors.description} className="sm:col-span-2">
          <Textarea id="it-desc" rows={2} value={draft.description} onChange={(e) => set("description", e.target.value)} disabled={disabled} />
        </Field>
      </div>
      <fieldset className="grid gap-2.5 sm:grid-cols-2" disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">Use</legend>
        {flags.map(([k, label]) => (
          <div key={k} className="flex items-center gap-2">
            <Checkbox id={`it-${k}`} checked={draft[k] as boolean} onCheckedChange={(v) => set(k, (v === true) as never)}
              disabled={disabled || (k === "is_stocked" && draft.item_type === "service")} />
            <Label htmlFor={`it-${k}`} className="font-normal">{label}</Label>
          </div>
        ))}
      </fieldset>
    </div>
  );
}
