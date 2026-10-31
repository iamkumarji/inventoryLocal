"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { api, unwrap } from "@/lib/api/client";
import { useScopeTree } from "@/lib/api/hooks";
import type { components } from "@/lib/api/schema";
import type { ScopeTree } from "@/lib/scopes";
import { useSession } from "@/lib/session";

export type Partner = components["schemas"]["Partner"];
export type Item = components["schemas"]["Item"];
export type Uom = components["schemas"]["Uom"];

/** Query keys for this area all start with "trade" so one invalidation refreshes lists after an action. */
export const tradeKey = (...parts: unknown[]) => ["trade", ...parts] as const;

export function useUoms() {
  const query = useQuery({
    queryKey: tradeKey("uoms"),
    queryFn: () => unwrap(api.GET("/api/v1/masterdata/uoms/")),
    staleTime: 10 * 60_000,
  });
  const byId = useMemo(() => new Map((query.data ?? []).map((u) => [u.id, u])), [query.data]);
  return { ...query, code: (id: string | null | undefined) => (id ? byId.get(id)?.code ?? "—" : "—") };
}

/** Items index (code, name, units) for labelling document lines. */
export function useItemIndex() {
  const query = useQuery({
    queryKey: tradeKey("items", "index"),
    queryFn: () => unwrap(api.GET("/api/v1/masterdata/items/", { params: { query: { page_size: 500 } } })),
    staleTime: 5 * 60_000,
  });
  const byId = useMemo(() => new Map((query.data?.results ?? []).map((i) => [i.id, i])), [query.data]);
  return { ...query, get: (id: string | null | undefined) => (id ? byId.get(id) : undefined) };
}

export function useItemSearch(term: string, filter: { is_purchasable?: boolean; is_saleable?: boolean }, enabled = true) {
  return useQuery({
    queryKey: tradeKey("items", "search", term, filter),
    queryFn: () =>
      unwrap(api.GET("/api/v1/masterdata/items/", {
        params: { query: { search: term || undefined, is_active: true, page_size: 25, ...filter } },
      })),
    enabled,
  });
}

export type PartnerKind = "supplier" | "customer";

export function usePartnerSearch(kind: PartnerKind, term: string, enabled = true) {
  return useQuery({
    queryKey: tradeKey("partners", "search", kind, term),
    queryFn: () =>
      unwrap(api.GET("/api/v1/partners/", {
        params: {
          query: {
            search: term || undefined,
            is_active: true,
            page_size: 25,
            ...(kind === "supplier" ? { is_supplier: true } : { is_customer: true }),
          },
        },
      })),
    enabled,
  });
}

/** Partner names by id, for documents that only carry the partner's id. */
export function usePartnerIndex(kind: PartnerKind) {
  const query = useQuery({
    queryKey: tradeKey("partners", "index", kind),
    queryFn: () =>
      unwrap(api.GET("/api/v1/partners/", {
        params: { query: { page_size: 500, ...(kind === "supplier" ? { is_supplier: true } : { is_customer: true }) } },
      })),
    staleTime: 60_000,
  });
  const byId = useMemo(() => new Map((query.data?.results ?? []).map((p) => [p.id, p])), [query.data]);
  return { ...query, get: (id: string | null | undefined) => (id ? byId.get(id) : undefined), name: (id: string | null | undefined) => (id ? byId.get(id)?.name ?? "—" : "—") };
}

export type WarehouseOption = { id: string; code: string; name: string; type?: string; branchId: string; branchCode: string };
export type BranchOption = { id: string; code: string; name: string };

/** Branches, warehouses and departments of the active company that the caller can see. */
export function useCompanyScopes() {
  const { activeCompany } = useSession();
  const tree = useScopeTree();
  return useMemo(() => {
    const companies = (tree.data as ScopeTree | undefined)?.companies ?? [];
    const company = companies.find((c) => c.id === activeCompany?.id) ?? companies[0];
    const branches: BranchOption[] = (company?.branches ?? []).map((b) => ({ id: b.id, code: b.code, name: b.name }));
    const warehouses: WarehouseOption[] = (company?.branches ?? []).flatMap((b) =>
      b.warehouses.map((w) => ({ ...(w as { id: string; code: string; name: string; type?: string }), branchId: b.id, branchCode: b.code })),
    );
    const departments = (company?.departments ?? []).map((d) => ({ id: d.id, code: d.code, name: d.name }));
    const names = new Map<string, string>([...branches, ...warehouses, ...departments].map((n) => [n.id, n.name]));
    return {
      companyId: company?.id ?? activeCompany?.id ?? "",
      branches,
      warehouses,
      departments,
      isLoading: tree.isLoading,
      name: (id: string | null | undefined) => (id ? names.get(id) ?? "Outside your view" : "—"),
    };
  }, [tree.data, tree.isLoading, activeCompany?.id]);
}
