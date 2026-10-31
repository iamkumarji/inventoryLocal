import { cn } from "@/lib/utils";

/**
 * ISO 3864 safety semantics: green = approved/safe, amber = pending/caution,
 * red = rejected/stop, blue = informational, steel = inactive/neutral.
 */
export type Tone = "approved" | "pending" | "rejected" | "info" | "neutral";

const TONE_CLASSES: Record<Tone, string> = {
  approved: "text-status-approved bg-status-approved/10 border-status-approved/25",
  pending: "text-status-pending bg-status-pending/10 border-status-pending/25",
  rejected: "text-status-rejected bg-status-rejected/10 border-status-rejected/25",
  info: "text-status-info bg-status-info/10 border-status-info/25",
  neutral: "text-status-neutral bg-muted border-border",
};

const DOT: Record<Tone, string> = {
  approved: "bg-status-approved",
  pending: "bg-status-pending",
  rejected: "bg-status-rejected",
  info: "bg-status-info",
  neutral: "bg-status-neutral",
};

export function StatusBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-[1px]", DOT[tone])} />
      {children}
    </span>
  );
}

const APPROVAL_TONES: Record<string, Tone> = {
  pending: "pending",
  approved: "approved",
  rejected: "rejected",
  withdrawn: "neutral",
  skipped: "neutral",
};

export function ApprovalStatus({ status }: { status: string }) {
  return <StatusBadge tone={APPROVAL_TONES[status] ?? "neutral"}>{status.charAt(0).toUpperCase() + status.slice(1)}</StatusBadge>;
}

export function ActiveStatus({ active, activeLabel = "Active", inactiveLabel = "Inactive" }: {
  active: boolean;
  activeLabel?: string;
  inactiveLabel?: string;
}) {
  return <StatusBadge tone={active ? "approved" : "neutral"}>{active ? activeLabel : inactiveLabel}</StatusBadge>;
}
