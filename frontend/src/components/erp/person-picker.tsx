"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, unwrap } from "@/lib/api/client";

export type Person = { id: string; full_name: string; email: string };

/** Searches the colleague directory (name and email only). */
export function PersonPicker({ id, value, onChange, placeholder = "Choose a person" }: {
  id?: string;
  value: Person | null;
  onChange: (person: Person | null) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const results = useQuery({
    queryKey: ["directory", term],
    queryFn: () => unwrap(api.GET("/api/v1/identity/directory/", { params: { query: { search: term } } })),
    enabled: open && term.length >= 2,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
          <span className={value ? "" : "text-muted-foreground"}>{value ? value.full_name : placeholder}</span>
          <ChevronsUpDown className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Type a name or email" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{term.length < 2 ? "Type at least 2 characters." : results.isLoading ? "Searching…" : "No one matches."}</CommandEmpty>
            {results.data && results.data.length > 0 && (
              <CommandGroup>
                {results.data.map((p) => (
                  <CommandItem key={p.id} value={p.id} onSelect={() => { onChange(p); setOpen(false); }}>
                    <span className="flex-1">{p.full_name}<span className="block text-xs text-muted-foreground">{p.email}</span></span>
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
