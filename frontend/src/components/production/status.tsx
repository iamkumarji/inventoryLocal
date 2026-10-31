import { StatusBadge, type Tone } from "@/components/erp/status";
import { humanize } from "@/lib/api/production";

/** ISO 3864 tones per document state (green done/safe, amber in flight, red stop, blue info, steel inactive). */
const TONES: Record<string, Record<string, Tone>> = {
  order: { draft: "neutral", released: "info", in_progress: "pending", completed: "approved", closed: "neutral", cancelled: "rejected" },
  bomVersion: { draft: "pending", approved: "approved", obsolete: "neutral" },
  asset: { draft: "neutral", submitted: "pending", approved: "info", rejected: "rejected", capitalized: "approved", disposed: "neutral" },
  run: { draft: "pending", posted: "approved", reversed: "neutral" },
  workOrder: { open: "info", in_progress: "pending", completed: "approved", closed: "neutral", cancelled: "rejected" },
  task: { open: "info", in_progress: "pending", done: "approved", cancelled: "neutral" },
  priority: { low: "neutral", normal: "info", high: "pending", urgent: "rejected" },
  confidentiality: { internal: "neutral", restricted: "pending", confidential: "rejected" },
};

export function StateBadge({ kind, value, label }: { kind: keyof typeof TONES; value: string; label?: string }) {
  return <StatusBadge tone={TONES[kind]?.[value] ?? "neutral"}>{label ?? humanize(value)}</StatusBadge>;
}
