"use client";

import { useQuery } from "@tanstack/react-query";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";

/** Capitalized assets (the ones that can be maintained or metered). */
export function useActiveAssets(enabled = true) {
  return useQuery({
    queryKey: ["assets", "register", "capitalized-all"],
    queryFn: () => unwrap(api.GET("/api/v1/assets/assets/", { params: { query: { status: "capitalized", page_size: 200 } } })),
    enabled,
    staleTime: 60_000,
  });
}

export function AssetSelect({ id, value, onChange }: { id: string; value: string; onChange: (id: string) => void }) {
  const assets = useActiveAssets();
  const rows = assets.data?.results ?? [];
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="h-10 w-full min-w-0">
        <SelectValue placeholder={assets.isLoading ? "Loading…" : rows.length ? "Choose an asset" : "No capitalized assets"} />
      </SelectTrigger>
      <SelectContent>{rows.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} · {a.name}</SelectItem>)}</SelectContent>
    </Select>
  );
}

export type ChecklistEntry = { item: string; done: boolean };

/** Checklists are free-form JSON lists; plans created here store `{item, done}` entries. */
export function readChecklist(value: unknown): ChecklistEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return { item: entry, done: false };
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      return { item: String(e.item ?? e.label ?? e.task ?? JSON.stringify(e)), done: e.done === true };
    }
    return { item: String(entry), done: false };
  });
}
