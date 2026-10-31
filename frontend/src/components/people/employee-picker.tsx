"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, unwrap } from "@/lib/api/client";

/** Searches employees the caller may see (code, name or designation). `value` is an employee id. */
export function EmployeePicker({ id, value, onChange, placeholder = "Choose an employee", allowClear = false, activeOnly = true, className = "" }: {
  id?: string;
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  allowClear?: boolean;
  activeOnly?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const results = useQuery({
    queryKey: ["people", "employee-search", term, activeOnly],
    queryFn: () => unwrap(api.GET("/api/v1/hr/employees/", {
      params: { query: { search: term || undefined, status: activeOnly ? "active" : undefined, page_size: 20 } },
    })),
    enabled: open,
  });
  const selected = useQuery({
    queryKey: ["people", "employee", value],
    queryFn: () => unwrap(api.GET("/api/v1/hr/employees/{id}/", { params: { path: { id: value } } })),
    enabled: Boolean(value),
    staleTime: 60_000,
  });
  const label = value ? (selected.data ? `${selected.data.code} · ${selected.data.full_name}` : "Loading…") : placeholder;

  return (
    <div className={`flex min-w-0 gap-1 ${className}`}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} className="min-w-0 flex-1 justify-between font-normal">
            <span className={`truncate ${value ? "" : "text-muted-foreground"}`}>{label}</span>
            <ChevronsUpDown className="opacity-50" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(var(--radix-popover-trigger-width),calc(100vw-2rem))] min-w-64 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Code or name" value={search} onValueChange={setSearch} />
            <CommandList>
              <CommandEmpty>{results.isLoading ? "Searching…" : "No employee matches."}</CommandEmpty>
              {results.data && results.data.results.length > 0 && (
                <CommandGroup>
                  {results.data.results.map((e) => (
                    <CommandItem key={e.id} value={e.id} onSelect={() => { onChange(e.id); setOpen(false); }}>
                      <span className="flex-1">
                        {e.full_name}
                        <span className="block text-xs text-muted-foreground">{e.code} · {e.department_name}</span>
                      </span>
                      {value === e.id && <Check aria-hidden />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {allowClear && value && (
        <Button type="button" variant="ghost" size="icon" onClick={() => onChange("")} aria-label="Clear employee">
          <X aria-hidden />
        </Button>
      )}
    </div>
  );
}
