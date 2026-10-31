import { Lock } from "lucide-react";

import { StatusBadge, type Tone } from "@/components/erp/status";
import { humanize } from "@/lib/api/people";
import { money } from "@/lib/format";

/**
 * A money amount from the API. `undefined` means the API withheld it (salary data the caller may
 * not read), which is shown as "Restricted", never as zero.
 */
export function Amount({ value, currency = "INR", className = "" }: {
  value: string | null | undefined;
  currency?: string;
  className?: string;
}) {
  if (value === undefined) {
    return (
      <span className={`inline-flex items-center gap-1 text-muted-foreground ${className}`} title="You don't have access to salary amounts">
        <Lock className="size-3.5" aria-hidden />
        Restricted
      </span>
    );
  }
  return <span className={`num ${className}`}>{money(value, currency)}</span>;
}

const TONES: Record<string, Tone> = {
  draft: "neutral",
  requested: "pending",
  submitted: "pending",
  computed: "info",
  approved: "approved",
  posted: "approved",
  paid: "approved",
  settled: "neutral",
  rejected: "rejected",
  reversed: "neutral",
  cancelled: "neutral",
  active: "approved",
  exited: "neutral",
  present: "approved",
  half_day: "pending",
  absent: "rejected",
  leave: "info",
  holiday: "neutral",
};

/** Document and record states in ISO 3864 tones. */
export function DocStatus({ status }: { status: string }) {
  return <StatusBadge tone={TONES[status] ?? "neutral"}>{humanize(status)}</StatusBadge>;
}
