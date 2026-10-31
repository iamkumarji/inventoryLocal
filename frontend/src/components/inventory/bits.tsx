"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { useWarehouses, type Item } from "@/lib/api/inventory";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import { problemCode, problemText } from "./problem";

/** The API's problem message (and business-rule code) right next to the action that failed. */
export function ActionError({ error, denied, className }: { error: unknown; denied?: string; className?: string }) {
  const text = problemText(error, denied);
  if (!text) return null;
  const code = problemCode(error);
  return (
    <div role="alert" className={cn("rounded-md border border-status-rejected/30 bg-status-rejected/10 px-3 py-2 text-sm text-status-rejected", className)}>
      {text}
      {code && <span className="ml-2 rounded-sm bg-status-rejected/10 px-1.5 py-0.5 font-mono text-xs">{code}</span>}
    </div>
  );
}

/** Two-column facts list that wraps cleanly on phones. */
export function Facts({ items, className }: { items: Array<[ReactNode, ReactNode] | false | null | undefined>; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm", className)}>
      {items.filter(Boolean).map((pair, i) => {
        const [k, v] = pair as [ReactNode, ReactNode];
        return (
          <span key={i} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </span>
        );
      })}
    </dl>
  );
}

/** Documents carry user ids only; we can say whether it was the caller. */
export function Who({ id }: { id: string | null | undefined }) {
  const { me } = useSession();
  if (!id) return <span className="text-muted-foreground">—</span>;
  return id === me.user.id ? <span>You</span> : <span className="text-muted-foreground">Another user</span>;
}

export const ANY = "__any__";

export function WarehouseSelect({ id, value, onChange, allowAny, anyLabel = "All warehouses", exclude, placeholder = "Choose a warehouse", className, disabled, ariaLabel }: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  allowAny?: boolean;
  anyLabel?: string;
  exclude?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const { warehouses } = useWarehouses();
  return (
    <Select value={value || (allowAny ? ANY : "")} onValueChange={(v) => onChange(v === ANY ? "" : v)} disabled={disabled}>
      <SelectTrigger id={id} className={cn("w-full", className)} aria-label={ariaLabel}><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {allowAny && <SelectItem value={ANY}>{anyLabel}</SelectItem>}
        {warehouses.filter((w) => w.id !== exclude).map((w) => (
          <SelectItem key={w.id} value={w.id}><span className="num">{w.code}</span> <span className="text-muted-foreground">{w.name}</span></SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export type ItemOption = Pick<Item, "id" | "code" | "name" | "tracking" | "stock_uom_code" | "inspection_required">;

/** Searches active items by code, name or barcode. */
export function ItemPicker({ id, value, onChange, placeholder = "Choose an item", className, ariaLabel }: {
  id?: string;
  value: ItemOption | null;
  onChange: (item: ItemOption | null) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);
  const results = useQuery({
    queryKey: ["masterdata", "items", "picker", term],
    queryFn: () => unwrap(api.GET("/api/v1/masterdata/items/", { params: { query: { search: term || undefined, is_active: true, page_size: 20 } } })),
    enabled: open,
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-label={ariaLabel}
          className={cn("w-full min-w-0 justify-between font-normal", className)}>
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value ? <><span className="num font-medium">{value.code}</span> {value.name}</> : placeholder}
          </span>
          <ChevronsUpDown className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Code, name or barcode" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{results.isLoading ? "Searching…" : "No active item matches."}</CommandEmpty>
            {results.data && results.data.results.length > 0 && (
              <CommandGroup>
                {results.data.results.map((item) => (
                  <CommandItem key={item.id} value={item.id} onSelect={() => { onChange(item); setOpen(false); }}>
                    <span className="min-w-0 flex-1">
                      <span className="num font-medium">{item.code}</span> <span>{item.name}</span>
                      <span className="block text-xs text-muted-foreground">{item.stock_uom_code}{item.tracking && item.tracking !== "none" ? `, ${item.tracking} tracked` : ""}</span>
                    </span>
                    {value?.id === item.id && <Check aria-hidden />}
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

/** Filter bar that wraps on narrow screens. */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{children}</div>;
}

/** "What happens next" block on document pages: the step, why it matters, and the action. */
export function NextStep({ title, body, children }: { title: string; body: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="type-section">{title}</p>
        <p className="mt-0.5 max-w-[62ch] text-sm text-muted-foreground">{body}</p>
      </div>
      {children && <div className="flex shrink-0 flex-wrap gap-2">{children}</div>}
    </div>
  );
}

/**
 * Re-seeds a dialog's form whenever it opens (or switches to another record) and clears the previous
 * attempt's error, so a second "New …" never shows the last entry or its error.
 */
export function useSeedOnOpen<T>(open: boolean, record: T, seed: () => void, resetMutation?: () => void) {
  const [seen, setSeen] = useState<{ open: boolean; record: T } | null>(null);
  if (!seen || seen.open !== open || seen.record !== record) {
    setSeen({ open, record });
    if (open) seed();
  }
  useEffect(() => {
    if (open) resetMutation?.();
  }, [open, record, resetMutation]);
}
