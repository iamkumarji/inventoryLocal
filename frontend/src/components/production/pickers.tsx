"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";

import { PersonPicker, type Person } from "@/components/erp/person-picker";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { rememberPerson, useOrgPlaces, type Item, type Place } from "@/lib/api/production";
import { useSession } from "@/lib/session";

export type ItemRef = Pick<Item, "id" | "code" | "name"> & { stock_uom_code?: string };

/** Searches items by code, name or barcode. */
export function ItemPicker({ id, value, onChange, manufactured, placeholder = "Choose an item", invalid }: {
  id?: string;
  value: ItemRef | null;
  onChange: (item: ItemRef | null) => void;
  manufactured?: boolean;
  placeholder?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const results = useQuery({
    queryKey: ["masterdata", "items", "picker", term, manufactured ?? null],
    queryFn: () =>
      unwrap(api.GET("/api/v1/masterdata/items/", {
        params: { query: { search: term || undefined, is_manufactured: manufactured, is_active: true, page_size: 20 } },
      })),
    enabled: open,
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-invalid={invalid}
          className="h-10 w-full min-w-0 justify-between font-normal">
          <span className={value ? "truncate" : "truncate text-muted-foreground"}>
            {value ? `${value.code} · ${value.name}` : placeholder}
          </span>
          <ChevronsUpDown className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(var(--radix-popover-trigger-width),calc(100vw-2rem))] min-w-64 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Type a code or name" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{results.isLoading ? "Searching…" : "No item matches."}</CommandEmpty>
            {results.data && results.data.results.length > 0 && (
              <CommandGroup>
                {results.data.results.map((item) => (
                  <CommandItem key={item.id} value={item.id} onSelect={() => { onChange(item); setOpen(false); }}>
                    <span className="min-w-0 flex-1">
                      <span className="num block font-medium">{item.code}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.name} · {item.stock_uom_code}</span>
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

/** Facility or warehouse of the active company. */
export function PlaceSelect({ id, kind, value, onChange, types, placeholder = "Choose" }: {
  id: string;
  kind: "facility" | "warehouse";
  value: string;
  onChange: (id: string) => void;
  types?: string[];
  placeholder?: string;
}) {
  const places = useOrgPlaces();
  const list: Place[] = (kind === "facility" ? places.facilities : places.warehouses).filter((p) => !types || types.includes(p.type));
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="h-10 w-full min-w-0"><SelectValue placeholder={places.isLoading ? "Loading…" : list.length ? placeholder : "None available to you"} /></SelectTrigger>
      <SelectContent>
        {list.map((p) => <SelectItem key={p.id} value={p.id}>{p.code} · {p.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** Person picker that also offers "Me" (the colleague directory never lists the caller). */
export function PersonField({ id, value, onChange, placeholder }: {
  id?: string;
  value: Person | null;
  onChange: (person: Person | null) => void;
  placeholder?: string;
}) {
  const { me } = useSession();
  const self: Person = { id: me.user.id, full_name: me.user.full_name, email: me.user.email };
  return (
    <div className="flex min-w-0 gap-2">
      <div className="min-w-0 flex-1">
        <PersonPicker id={id} value={value} placeholder={placeholder} onChange={(p) => { rememberPerson(p); onChange(p); }} />
      </div>
      <Button type="button" variant="outline" onClick={() => onChange(value?.id === self.id ? null : self)} aria-pressed={value?.id === self.id}>
        Me
      </Button>
    </div>
  );
}
