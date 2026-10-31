import { StatusBadge, type Tone } from "@/components/erp/status";

type Spec = Record<string, [Tone, string]>;

const DOC: Spec = {
  draft: ["neutral", "Draft"],
  submitted: ["pending", "Submitted"],
  approved: ["info", "Approved, not posted"],
  rejected: ["rejected", "Rejected"],
  posted: ["approved", "Posted"],
  cancelled: ["neutral", "Cancelled"],
};

const TRANSFER: Spec = {
  draft: ["neutral", "Draft"],
  dispatched: ["pending", "In transit"],
  received: ["approved", "Received"],
  cancelled: ["neutral", "Cancelled"],
};

const COUNT: Spec = {
  counting: ["pending", "Counting"],
  submitted: ["info", "Submitted"],
  posted: ["approved", "Posted"],
  cancelled: ["neutral", "Cancelled"],
};

const INSPECTION: Spec = {
  pending: ["pending", "Waiting for decision"],
  accepted: ["approved", "Accepted"],
  rejected: ["rejected", "Rejected"],
  partially_accepted: ["info", "Partly accepted"],
};

const NCR: Spec = {
  open: ["pending", "Open"],
  closed: ["approved", "Closed"],
};

const STOCK: Spec = {
  unrestricted: ["approved", "Unrestricted"],
  quality_hold: ["pending", "Quality hold"],
  blocked: ["rejected", "Blocked"],
  in_transit: ["info", "In transit"],
};

const KINDS = { doc: DOC, transfer: TRANSFER, count: COUNT, inspection: INSPECTION, ncr: NCR, stock: STOCK } as const;

export function InvStatus({ kind, status }: { kind: keyof typeof KINDS; status: string }) {
  const [tone, label] = KINDS[kind][status] ?? ["neutral", status.replace(/_/g, " ")];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}
