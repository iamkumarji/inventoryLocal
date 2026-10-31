"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, unwrap } from "@/lib/api/client";
import type { Account } from "@/lib/api/finance";
import { cn } from "@/lib/utils";

function useDebounced(value: string, ms = 250) {
  const [term, setTerm] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setTerm(value.trim()), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return term;
}

export type PartnerOption = { id: string; name: string; code: string };

/** Searches suppliers or customers by name or code. */
export function PartnerPicker({ id, kind, value, onChange, placeholder }: {
  id?: string;
  kind: "supplier" | "customer";
  value: PartnerOption | null;
  onChange: (partner: PartnerOption | null) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const term = useDebounced(search);
  const results = useQuery({
    queryKey: ["partners", "picker", kind, term],
    queryFn: () =>
      unwrap(api.GET("/api/v1/partners/", {
        params: { query: { search: term || undefined, is_supplier: kind === "supplier" ? true : undefined,
          is_customer: kind === "customer" ? true : undefined, is_active: true, page_size: 20 } },
      })),
    enabled: open,
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
          <span className={cn("truncate", !value && "text-muted-foreground")}>{value ? value.name : placeholder ?? `Choose a ${kind}`}</span>
          <ChevronsUpDown className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Name or code" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>
              {results.isLoading ? "Searching…" : results.error ? "You can't look up partners. Ask for partner read access." : `No ${kind} matches.`}
            </CommandEmpty>
            {results.data && results.data.results.length > 0 && (
              <CommandGroup>
                {results.data.results.map((p) => (
                  <CommandItem key={p.id} value={p.id} onSelect={() => { onChange({ id: p.id, name: p.name, code: p.code }); setOpen(false); }}>
                    <span className="flex-1">{p.name}<span className="block text-xs text-muted-foreground">{p.code}</span></span>
                    {value?.id === p.id && <Check aria-hidden />}
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

/** Chooses a ledger account from an already-loaded chart (filters on code and name). */
export function AccountPicker({ id, accounts, value, onChange, placeholder = "Choose an account", invalid }: {
  id?: string;
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = accounts.find((a) => a.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-invalid={invalid}
          className="w-full min-w-0 justify-between font-normal">
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? <><span className="num">{selected.code}</span> {selected.name}</> : placeholder}
          </span>
          <ChevronsUpDown className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(26rem,calc(100vw-2rem))] p-0" align="start">
        <Command filter={(itemValue, search) => (itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}>
          <CommandInput placeholder="Code or name" />
          <CommandList>
            <CommandEmpty>No account matches.</CommandEmpty>
            <CommandGroup>
              {accounts.map((a) => (
                <CommandItem key={a.id} value={`${a.code} ${a.name}`} onSelect={() => { onChange(a.id); setOpen(false); }}>
                  <span className="num w-14 shrink-0 text-muted-foreground">{a.code}</span>
                  <span className="flex-1 truncate">{a.name}</span>
                  {value === a.id && <Check aria-hidden />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export type ItemOption = { id: string; code: string; name: string };

/** Searches the item master. */
export function ItemPicker({ id, value, onChange }: { id?: string; value: ItemOption | null; onChange: (item: ItemOption) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const term = useDebounced(search);
  const results = useQuery({
    queryKey: ["masterdata", "items", "picker", term],
    queryFn: () => unwrap(api.GET("/api/v1/masterdata/items/", { params: { query: { search: term || undefined, is_active: true, page_size: 20 } } })),
    enabled: open,
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal sm:w-80">
          <span className={cn("truncate", !value && "text-muted-foreground")}>{value ? `${value.code} · ${value.name}` : "Choose an item"}</span>
          <ChevronsUpDown className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(26rem,calc(100vw-2rem))] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Item code or name" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{results.isLoading ? "Searching…" : results.error ? "You can't look up items." : "No item matches."}</CommandEmpty>
            {results.data && results.data.results.length > 0 && (
              <CommandGroup>
                {results.data.results.map((item) => (
                  <CommandItem key={item.id} value={item.id} onSelect={() => { onChange({ id: item.id, code: item.code, name: item.name }); setOpen(false); }}>
                    <span className="num w-20 shrink-0 text-muted-foreground">{item.code}</span>
                    <span className="flex-1 truncate">{item.name}</span>
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
