"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useSession } from "@/lib/session";

import { api, unwrap } from "./client";
import { useScopeTree } from "./hooks";
import type { components } from "./schema";

type S = components["schemas"];
export type Item = S["Item"];
export type Uom = S["Uom"];
export type UomConversion = S["UomConversion"];
export type ItemCategory = S["ItemCategory"];
export type HsnCode = S["HsnCode"];
export type ItemPolicy = S["ItemWarehousePolicy"];
export type Stock = S["Stock"];
export type Ledger = S["Ledger"];
export type Adjustment = S["Adjustment"];
export type Transfer = S["Transfer"];
export type Count = S["Count"];
export type Inspection = S["Inspection"];
export type NCR = S["NCR"];
export type Plan = S["Plan"];
export type Location = S["Location"];
export type Batch = S["Batch"];

/** The availability endpoint's real payload (the OpenAPI schema only declares `available`). */
export type Availability = {
  on_hand: string;
  unrestricted: string;
  quality_hold: string;
  blocked: string;
  in_transit: string;
  reserved: string;
  available: string;
  avg_cost: string;
  value: string;
};

export type AgeingRow = {
  item_id: string;
  item_code: string;
  item_name: string;
  warehouse_id: string;
  warehouse_code: string;
  quantity: string;
  value: string;
  buckets: Record<string, string>;
};

/** Count lines are typed `unknown[]` in the schema; this is what the serializer returns. */
export type CountLine = {
  id: string;
  item: string;
  item_code: string;
  item_name: string;
  location: string | null;
  batch: string | null;
  /** null while a blind count is open and the caller can't approve it. */
  system_quantity: string | null;
  counted_quantity: string | null;
  counted_by: string | null;
};

export type ScanResult =
  | { kind: "item"; item_id: string; item_code: string; uom_id: string | null }
  | { kind: "serial"; serial_id: string; item_id: string; item_code: string; status: string; warehouse_id: string | null }
  | { kind: "batch"; batch_id: string; item_id: string; item_code: string; expires_on: string | null }
  | { kind: "location"; location_id: string; warehouse_id: string };

/** Inspection plan parameter as stored in `Plan.parameters`. */
export type PlanParameter = { name: string; kind: "numeric" | "pass_fail"; min?: string | null; max?: string | null; unit?: string };

export type WarehouseOption = {
  id: string;
  code: string;
  name: string;
  type: string;
  companyId: string;
  companyCode: string;
  branchCode: string;
};

type TreeNode = { id: string; code: string; name: string; type?: string };
type Tree = { companies: Array<TreeNode & { branches: Array<TreeNode & { warehouses: TreeNode[]; facilities: TreeNode[] }> }> };

/** Warehouses the caller can see (from the scope tree), optionally limited to the active company. */
export function useWarehouses({ activeCompanyOnly = true }: { activeCompanyOnly?: boolean } = {}) {
  const tree = useScopeTree();
  const { activeCompany } = useSession();
  const all = useMemo<WarehouseOption[]>(() => {
    const out: WarehouseOption[] = [];
    for (const company of (tree.data as Tree | undefined)?.companies ?? []) {
      for (const branch of company.branches) {
        for (const w of branch.warehouses) {
          out.push({ id: w.id, code: w.code, name: w.name, type: w.type ?? "", companyId: company.id, companyCode: company.code, branchCode: branch.code });
        }
      }
    }
    return out;
  }, [tree.data]);
  const list = activeCompanyOnly && activeCompany ? all.filter((w) => w.companyId === activeCompany.id) : all;
  const byId = useMemo(() => new Map(all.map((w) => [w.id, w])), [all]);
  return {
    warehouses: list,
    isLoading: tree.isLoading,
    error: tree.error,
    label: (id: string | null | undefined) => (id ? byId.get(id)?.code ?? "Warehouse outside your view" : "—"),
    get: (id: string | null | undefined) => (id ? byId.get(id) : undefined),
  };
}

export function useUoms(enabled = true) {
  return useQuery({
    queryKey: ["masterdata", "uoms"],
    queryFn: () => unwrap(api.GET("/api/v1/masterdata/uoms/", { params: { query: { ordering: "code" } } })),
    staleTime: 60_000,
    enabled,
  });
}

export function useCategories(enabled = true) {
  return useQuery({
    queryKey: ["masterdata", "categories"],
    queryFn: () => unwrap(api.GET("/api/v1/masterdata/item-categories/", { params: { query: { ordering: "code" } } })),
    staleTime: 60_000,
    enabled,
  });
}

export function useHsnCodes(search = "", enabled = true) {
  return useQuery({
    queryKey: ["masterdata", "hsn", "options", search],
    queryFn: () => unwrap(api.GET("/api/v1/masterdata/hsn-codes/", { params: { query: { search: search || undefined, page_size: 200 } } })),
    staleTime: 60_000,
    enabled,
  });
}

export function useItem(id: string | null | undefined) {
  return useQuery({
    queryKey: ["masterdata", "item", id],
    queryFn: () => unwrap(api.GET("/api/v1/masterdata/items/{id}/", { params: { path: { id: id! } } })),
    enabled: !!id,
  });
}

export function useLocations(warehouse: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["inventory", "locations", warehouse],
    queryFn: () => unwrap(api.GET("/api/v1/inventory/locations/", { params: { query: { warehouse: warehouse!, is_active: true, page_size: 200 } } })),
    enabled: !!warehouse && enabled,
    staleTime: 60_000,
  });
}

export function useAvailability(item: string | null | undefined, warehouse: string | null | undefined) {
  return useQuery({
    queryKey: ["inventory", "availability", item, warehouse],
    queryFn: async () =>
      (await unwrap(api.GET("/api/v1/inventory/availability/", { params: { query: { item: item!, warehouse: warehouse! } } }))) as unknown as Availability,
    enabled: !!item && !!warehouse,
  });
}

/** Whether the item has any stock movements (stock UoM and tracking lock once it does). */
export function useItemHasHistory(item: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["inventory", "ledger", "has-history", item],
    queryFn: async () => {
      const page = await unwrap(api.GET("/api/v1/inventory/ledger/", { params: { query: { item: item!, page_size: 1 } } }));
      return page.results.length > 0;
    },
    enabled: !!item && enabled,
  });
}

/** Extracts the cursor parameter from a DRF cursor-pagination link. */
export function cursorFrom(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    return new URL(link, "http://localhost").searchParams.get("cursor");
  } catch {
    return null;
  }
}

export const ITEM_TYPES: Record<string, string> = {
  raw_material: "Raw material",
  component: "Component",
  consumable: "Consumable",
  semi_finished: "Semi-finished",
  finished_good: "Finished good",
  service: "Service",
  spare: "Spare",
  packaging: "Packaging",
};

export const TRACKING: Record<string, string> = { none: "Not tracked", batch: "Batch", serial: "Serial number" };

export const ADJUSTMENT_REASONS: Record<string, string> = {
  opening_balance: "Opening balance",
  found: "Found",
  correction: "Correction",
  damage: "Damage",
  expiry: "Expiry",
  loss: "Loss",
};

export const STAGES: Record<string, string> = { receipt: "Receipt", in_process: "In process", final: "Final" };

export const DISPOSITIONS: Record<string, string> = {
  return_to_supplier: "Return to supplier",
  rework: "Rework",
  scrap: "Scrap",
  use_as_is: "Use as is",
};

export const MOVEMENT_LABELS: Record<string, string> = {
  receipt: "Goods receipt",
  adjustment_in: "Adjustment in",
  adjustment_out: "Adjustment out",
  transfer_out: "Transfer out",
  transfer_in_transit: "In transit",
  transfer_receive: "Transit cleared",
  transfer_in: "Transfer in",
  count_gain: "Count gain",
  count_loss: "Count loss",
  status_out: "Status change out",
  status_in: "Status change in",
  backflush: "Backflush",
  production_consumption: "Production consumption",
  production_receipt: "Production output",
  production_issue: "Issued to production",
  production_issue_in: "Received into WIP",
  production_return: "Returned from production",
  production_return_in: "Returned to store",
  issue: "Issue",
  maintenance_issue: "Maintenance issue",
  opening: "Opening",
  purchase_return: "Purchase return",
  sales_issue: "Sales issue",
  sales_return: "Sales return",
  scrap: "Scrap",
};

export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
