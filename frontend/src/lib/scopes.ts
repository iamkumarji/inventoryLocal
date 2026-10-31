"use client";

import { useScopeTree } from "@/lib/api/hooks";
import { useSession } from "@/lib/session";

export type ScopeOption = { type: string; id: string; label: string; depth: number };

type Node = { id: string; code: string; name: string };
export type ScopeTree = {
  companies: Array<Node & {
    branches: Array<Node & { facilities: Node[]; warehouses: Node[] }>;
    departments: Array<Node & { parent_id: string | null }>;
  }>;
};

/** Flattens the visible organization tree into labelled options and a lookup. */
export function useScopeOptions() {
  const tree = useScopeTree();
  const { me } = useSession();
  const options: ScopeOption[] = [];
  if (me.user.organization_id) options.push({ type: "organization", id: me.user.organization_id, label: "Whole organization", depth: 0 });
  for (const company of ((tree.data as ScopeTree | undefined)?.companies ?? [])) {
    options.push({ type: "company", id: company.id, label: company.name, depth: 0 });
    for (const branch of company.branches) {
      options.push({ type: "branch", id: branch.id, label: `${company.code} / ${branch.name}`, depth: 1 });
      for (const facility of branch.facilities) {
        options.push({ type: "facility", id: facility.id, label: `${company.code} / ${branch.code} / ${facility.name}`, depth: 2 });
      }
      for (const warehouse of branch.warehouses) {
        options.push({ type: "warehouse", id: warehouse.id, label: `${company.code} / ${branch.code} / ${warehouse.name}`, depth: 2 });
      }
    }
    for (const dept of company.departments) {
      options.push({ type: "department", id: dept.id, label: `${company.code} / ${dept.name}`, depth: 1 });
    }
  }
  const byId = new Map(options.map((o) => [o.id, o]));
  return { options, label: (id: string) => byId.get(id)?.label ?? "Outside your view", isLoading: tree.isLoading };
}

export const SCOPE_TYPE_LABEL: Record<string, string> = {
  organization: "Organization",
  company: "Company",
  branch: "Branch",
  facility: "Facility",
  department: "Department",
  warehouse: "Warehouse",
};
