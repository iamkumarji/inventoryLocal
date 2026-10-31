"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type Item,
  type Partner,
  type PartnerKind,
  useCompanyScopes,
  useItemSearch,
  usePartnerSearch,
  useUoms,
} from "@/lib/api/trade";

function useDebounced(value: string, ms = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value.trim()), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function Combo<T extends { id: string }>({ id, label, placeholder, value, open, setOpen, search, setSearch, results, loading, render, onPick, ariaLabel }: {
  id?: string;
  label: string | null;
  placeholder: string;
  value: string | null;
  open: boolean;
  setOpen: (o: boolean) => void;
  search: string;
  setSearch: (s: string) => void;
  results: T[] | undefined;
  loading: boolean;
  render: (row: T) => React.ReactNode;
  onPick: (row: T) => void;
  ariaLabel?: string;
}) {
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-label={ariaLabel}
          className="w-full min-w-0 justify-between font-normal">
          <span className={`truncate ${label ? "" : "text-muted-foreground"}`}>{label ?? placeholder}</span>
          <ChevronsUpDown className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(var(--radix-popover-trigger-width),calc(100vw-2rem))] min-w-[16rem] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Type a code or name" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{loading ? "Searching…" : "Nothing matches."}</CommandEmpty>
            {results && results.length > 0 && (
              <CommandGroup>
                {results.map((row) => (
                  <CommandItem key={row.id} value={row.id} onSelect={() => { onPick(row); setOpen(false); }}>
                    <span className="min-w-0 flex-1">{render(row)}</span>
                    {value === row.id && <Check aria-hidden />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function ItemPicker({ id, value, label, onChange, purpose, ariaLabel }: {
  id?: string;
  value: string;
  label: string | null;
  onChange: (item: Item) => void;
  purpose: "purchase" | "sale";
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const term = useDebounced(search);
  const results = useItemSearch(term, purpose === "purchase" ? { is_purchasable: true } : { is_saleable: true }, open);
  return (
    <Combo id={id} label={label} placeholder="Choose an item" value={value} open={open} setOpen={setOpen} search={search}
      setSearch={setSearch} results={results.data?.results} loading={results.isLoading} onPick={onChange} ariaLabel={ariaLabel}
      render={(i) => <><span className="num font-medium">{i.code}</span> <span className="text-muted-foreground">{i.name}</span></>} />
  );
}

export function PartnerPicker({ id, kind, value, label, onChange, ariaLabel }: {
  id?: string;
  kind: PartnerKind;
  value: string;
  label: string | null;
  onChange: (partner: Partner) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const term = useDebounced(search);
  const results = usePartnerSearch(kind, term, open);
  return (
    <Combo id={id} label={label} placeholder={kind === "supplier" ? "Choose a supplier" : "Choose a customer"} value={value}
      open={open} setOpen={setOpen} search={search} setSearch={setSearch} results={results.data?.results} loading={results.isLoading}
      onPick={onChange} ariaLabel={ariaLabel}
      render={(p) => (
        <>
          <span className="block">{p.name}</span>
          <span className="block text-xs text-muted-foreground">
            {p.code}{p.gstin ? ` · ${p.gstin}` : ""}{p.state_code ? ` · state ${p.state_code}` : ""}
            {kind === "supplier" && p.supplier_profile && !p.supplier_profile.is_approved_vendor ? " · not approved" : ""}
            {p.is_blocked ? " · blocked" : ""}
          </span>
        </>
      )} />
  );
}

export function BranchSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const scopes = useCompanyScopes();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full"><SelectValue placeholder={scopes.isLoading ? "Loading…" : "Choose a branch"} /></SelectTrigger>
      <SelectContent>{scopes.branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
    </Select>
  );
}

export function WarehouseSelect({ id, value, onChange, branchId, ariaLabel, allowedIds }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  branchId?: string;
  ariaLabel?: string;
  allowedIds?: string[];
}) {
  const scopes = useCompanyScopes();
  const options = scopes.warehouses.filter((w) => (!branchId || w.branchId === branchId) && (!allowedIds || allowedIds.includes(w.id)));
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full min-w-0" aria-label={ariaLabel}><SelectValue placeholder="Warehouse" /></SelectTrigger>
      <SelectContent>{options.map((w) => <SelectItem key={w.id} value={w.id}>{w.branchCode} / {w.name}</SelectItem>)}</SelectContent>
    </Select>
  );
}

export function UomSelect({ id, value, onChange, allowed, ariaLabel }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  /** Restrict to these unit ids (the item's stock/purchase/sales units), when known. */
  allowed?: (string | null | undefined)[];
  ariaLabel?: string;
}) {
  const uoms = useUoms();
  const ids = allowed?.filter(Boolean) as string[] | undefined;
  const options = (uoms.data ?? []).filter((u) => u.is_active !== false && (!ids?.length || ids.includes(u.id)));
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full min-w-0" aria-label={ariaLabel}><SelectValue placeholder="Unit" /></SelectTrigger>
      <SelectContent>{options.map((u) => <SelectItem key={u.id} value={u.id}>{u.code}</SelectItem>)}</SelectContent>
    </Select>
  );
}

/** Indian GST state codes (first two digits of a GSTIN). */
export const GST_STATES: [string, string][] = [
  ["01", "Jammu and Kashmir"], ["02", "Himachal Pradesh"], ["03", "Punjab"], ["04", "Chandigarh"], ["05", "Uttarakhand"],
  ["06", "Haryana"], ["07", "Delhi"], ["08", "Rajasthan"], ["09", "Uttar Pradesh"], ["10", "Bihar"], ["11", "Sikkim"],
  ["12", "Arunachal Pradesh"], ["13", "Nagaland"], ["14", "Manipur"], ["15", "Mizoram"], ["16", "Tripura"], ["17", "Meghalaya"],
  ["18", "Assam"], ["19", "West Bengal"], ["20", "Jharkhand"], ["21", "Odisha"], ["22", "Chhattisgarh"], ["23", "Madhya Pradesh"],
  ["24", "Gujarat"], ["26", "Dadra and Nagar Haveli and Daman and Diu"], ["27", "Maharashtra"], ["29", "Karnataka"], ["30", "Goa"],
  ["31", "Lakshadweep"], ["32", "Kerala"], ["33", "Tamil Nadu"], ["34", "Puducherry"], ["35", "Andaman and Nicobar Islands"],
  ["36", "Telangana"], ["37", "Andhra Pradesh"], ["38", "Ladakh"], ["97", "Other territory"],
];

export function stateName(code: string | null | undefined): string {
  if (!code) return "—";
  return GST_STATES.find(([c]) => c === code)?.[1] ?? code;
}

export function StateSelect({ id, value, onChange, ariaLabel }: { id: string; value: string; onChange: (v: string) => void; ariaLabel?: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full" aria-label={ariaLabel}><SelectValue placeholder="Choose a state" /></SelectTrigger>
      <SelectContent>{GST_STATES.map(([code, name]) => <SelectItem key={code} value={code}>{code} · {name}</SelectItem>)}</SelectContent>
    </Select>
  );
}
