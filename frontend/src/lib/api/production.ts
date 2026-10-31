"use client";

import { format } from "date-fns";

import { useScopeTree } from "@/lib/api/hooks";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { useSession } from "@/lib/session";

/* Shared helpers for manufacturing, assets, collaboration and documents screens. */

type S = components["schemas"];
export type WorkCenter = S["WorkCenter"];
export type Bom = S["Bom"];
export type BomVersion = S["Version"];
export type ProductionOrder = S["ProductionOrder"];
export type ProductionMaterial = S["Material"];
export type ProductionOperation = S["ProdOperation"];
export type Asset = S["Asset"];
export type AssetCategory = S["AssetCategory"];
export type DepreciationRun = S["DepreciationRun"];
export type DepreciationPreviewLine = S["DepreciationPreviewLine"];
export type MaintenancePlan = S["MaintenancePlan"];
export type WorkOrder = S["WorkOrder"];
export type MeterReading = S["AssetMeterReading"];
export type Task = S["Task"];
export type EscalationRule = S["EscalationRule"];
export type Comment = S["Comment"];
export type ActivityEntry = S["ActivityEntry"];
export type ErpDocument = S["Document"];
export type DocumentVersion = S["DocumentVersion"];
export type Acl = S["Acl"];
export type Item = S["Item"];

/** The API documents only `shortage`; the service returns these fields (apps/manufacturing/services.py). */
export type Availability = { item_id: string; required: string; available: string; shortage: string };

/** Multi-level explosion node (apps/manufacturing/services.py `explode`). */
export type ExplosionNode = {
  item_id: string;
  item_code: string;
  quantity: string;
  bom_version?: number;
  leaf: boolean;
  children: ExplosionNode[];
};

/** Production order costing summary (apps/manufacturing/services.py `costing`). */
export type Costing = {
  produced_quantity: string;
  material_cost: string;
  labour_cost: string;
  machine_cost: string;
  overhead_cost: string;
  conversion_cost: string;
  absorbed_conversion: string;
  scrap_cost: string;
  total_cost: string;
  unit_cost: string;
  standard_cost: string;
  variance_per_unit: string | null;
};

// --- Dates --------------------------------------------------------------------------------------

/** Today's date in the browser's timezone, as the API expects (yyyy-MM-dd). */
export function today(): string {
  return format(new Date(), "yyyy-MM-dd");
}

export function firstOfMonth(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

/** `datetime-local` input value -> ISO string with the browser's offset. */
export function localToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function nowLocal(): string {
  return format(new Date(), "yyyy-MM-dd'T'HH:mm");
}

// --- Decimals -----------------------------------------------------------------------------------
// Quantities and money arrive and leave as decimal strings. Arithmetic (remaining to issue, defaults)
// is done in fixed point with BigInt — never with floats.

const SCALE = 6;
const FACTOR = BigInt(10 ** SCALE);
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function isDecimal(value: string, { maxDp = 6, allowNegative = false, allowZero = true } = {}): boolean {
  const v = value.trim();
  if (!DECIMAL_RE.test(v)) return false;
  if (!allowNegative && v.startsWith("-")) return false;
  const dp = v.split(".")[1]?.length ?? 0;
  if (dp > maxDp) return false;
  return allowZero || toUnits(v) !== BigInt(0);
}

function toUnits(value: string | null | undefined): bigint {
  const v = (value ?? "0").trim() || "0";
  if (!DECIMAL_RE.test(v)) return BigInt(0);
  const negative = v.startsWith("-");
  const [int, frac = ""] = v.replace("-", "").split(".");
  const units = BigInt(int) * FACTOR + BigInt((frac + "000000").slice(0, SCALE));
  return negative ? -units : units;
}

function fromUnits(units: bigint): string {
  const negative = units < BigInt(0);
  const abs = negative ? -units : units;
  const int = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

export const dec = {
  sub: (a: string, b: string) => fromUnits(toUnits(a) - toUnits(b)),
  add: (...values: string[]) => fromUnits(values.reduce((sum, v) => sum + toUnits(v), BigInt(0))),
  cmp: (a: string, b: string) => {
    const d = toUnits(a) - toUnits(b);
    return d === BigInt(0) ? 0 : d > BigInt(0) ? 1 : -1;
  },
  positive: (a: string | null | undefined) => toUnits(a) > BigInt(0),
  max0: (a: string) => (toUnits(a) > BigInt(0) ? fromUnits(toUnits(a)) : "0"),
  /** Normalised string (no trailing zeros) for display or as an input default. */
  norm: (a: string | null | undefined) => fromUnits(toUnits(a)),
};

const GROUP = new Intl.NumberFormat("en-IN");

/** Quantity for display: Indian digit grouping, trailing zeros dropped, no float conversion of the fraction. */
export function qty(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const normal = dec.norm(value);
  const negative = normal.startsWith("-");
  const [int, frac] = normal.replace("-", "").split(".");
  const grouped = GROUP.format(BigInt(int));
  return `${negative ? "−" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

// --- Labels -------------------------------------------------------------------------------------

export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One line for an action's error, shown next to the action. */
export function problemMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (isApiError(error, "version_conflict")) {
    return "Someone else changed this record while you were working. The latest version is shown; check it and try again.";
  }
  if (isApiError(error, "idempotency_in_progress")) return "This action is already being processed. Wait a moment and refresh.";
  if (isApiError(error)) return error.summary();
  return "Couldn't reach the server. Check your connection and try again.";
}

// --- People -------------------------------------------------------------------------------------
// The API returns people as bare ids and the directory can only be searched (not looked up by id),
// so names seen in this session (pickers, comments, tasks) are remembered for display.

const people = new Map<string, string>();

export function rememberPerson(person: { id: string; full_name: string } | null | undefined) {
  if (person) people.set(person.id, person.full_name);
}

export function usePersonLabel() {
  const { me } = useSession();
  return (id: string | null | undefined, fallback = "Someone else") => {
    if (!id) return "—";
    if (id === me.user.id) return `${me.user.full_name} (you)`;
    return people.get(id) ?? fallback;
  };
}

// --- Organization tree --------------------------------------------------------------------------

type TreeNode = { id: string; code: string; name: string; type?: string };
type Tree = {
  companies: Array<TreeNode & {
    branches: Array<TreeNode & { facilities: TreeNode[]; warehouses: TreeNode[] }>;
    departments: Array<TreeNode & { parent_id: string | null }>;
  }>;
};

export type Place = { id: string; code: string; name: string; type: string; branch: string };

/** Facilities, warehouses and departments of the active company that the caller can see. */
export function useOrgPlaces() {
  const tree = useScopeTree();
  const { activeCompany } = useSession();
  const company = ((tree.data as Tree | undefined)?.companies ?? []).find((c) => c.id === activeCompany?.id);
  const facilities: Place[] = [];
  const warehouses: Place[] = [];
  for (const branch of company?.branches ?? []) {
    for (const f of branch.facilities) facilities.push({ ...f, type: f.type ?? "", branch: branch.code });
    for (const w of branch.warehouses) warehouses.push({ ...w, type: w.type ?? "", branch: branch.code });
  }
  const departments = (company?.departments ?? []).map((d) => ({ id: d.id, code: d.code, name: d.name }));
  const byId = new Map<string, { code: string; name: string }>([...facilities, ...warehouses, ...departments].map((p) => [p.id, p]));
  return {
    companyId: activeCompany?.id ?? "",
    facilities,
    warehouses,
    departments,
    isLoading: tree.isLoading,
    label: (id: string | null | undefined) => (id ? (byId.get(id)?.name ?? "Outside your view") : "—"),
    code: (id: string | null | undefined) => (id ? (byId.get(id)?.code ?? "—") : "—"),
  };
}
