/**
 * Queued field operations. Each builds a job of HTTP steps; every endpoint used here honours
 * Idempotency-Key (backend test: apps/core/tests/test_mobile_idempotency.py — keep both in step).
 */
import type { Step } from "./queue/core";

type Steps = Omit<Step, "idempotencyKey">[];
export type Photo = { uri: string; name: string; type: string };

const json = (value: unknown) => ({ kind: "json" as const, value });

function upload(photo: Photo, title: string, resource?: { type: string; id: string }): Omit<Step, "idempotencyKey"> {
  const fields: Record<string, string> = { title, confidentiality: "internal" };
  if (resource) Object.assign(fields, { resource_type: resource.type, resource_id: resource.id });
  return { method: "POST", path: "/api/v1/documents/documents/", body: { kind: "file", fields, file: { field: "file", ...photo } } };
}

export function receiveGoods(input: {
  purchaseOrder: string;
  warehouse: string;
  receiptDate: string;
  deliveryNote: string;
  vehicle: string;
  lines: { po_line: string; quantity: string }[];
}): Steps {
  return [
    {
      method: "POST",
      path: "/api/v1/procurement/receipts/",
      body: json({
        purchase_order: input.purchaseOrder,
        warehouse: input.warehouse,
        receipt_date: input.receiptDate,
        supplier_delivery_note: input.deliveryNote,
        vehicle_number: input.vehicle,
        lines: input.lines,
      }),
    },
    { method: "POST", path: "/api/v1/procurement/receipts/{0.id}/post/", body: json({ version: { $ref: "0.version" } }) },
  ];
}

export function recordCount(countId: string, entries: { line_id?: string; item_id?: string; counted_quantity: string }[]): Steps {
  return [{ method: "POST", path: `/api/v1/inventory/counts/${countId}/record/`, body: json(entries) }];
}

export function receiveTransfer(transferId: string, version: number, on: string): Steps {
  return [{ method: "POST", path: `/api/v1/inventory/transfers/${transferId}/receive/`, body: json({ on, version }) }];
}

export function deliveryProof(input: {
  shipment: string;
  delivery: string;
  outcome: "delivered" | "partial" | "refused";
  receivedBy: string;
  receivedAt: string;
  signedNote: Photo | null;
  latitude: string | null;
  longitude: string | null;
  remarks: string;
}): Steps {
  const steps: Steps = [];
  if (input.signedNote) steps.push(upload(input.signedNote, "Signed delivery note", { type: "logistics.shipment", id: input.shipment }));
  steps.push({
    method: "POST",
    path: `/api/v1/logistics/shipments/${input.shipment}/proof/`,
    body: json({
      delivery: input.delivery,
      outcome: input.outcome,
      received_by_name: input.receivedBy,
      received_at: input.receivedAt,
      ...(input.signedNote ? { signature_document_id: { $ref: "0.id" } } : {}),
      ...(input.latitude && input.longitude ? { latitude: input.latitude, longitude: input.longitude } : {}),
      remarks: input.remarks,
    }),
  });
  return steps;
}

export function expenseClaim(input: {
  claimDate: string;
  purpose: string;
  category: string;
  description: string;
  amount: string;
  receipt: Photo | null;
}): Steps {
  const steps: Steps = [];
  if (input.receipt) steps.push(upload(input.receipt, `Receipt: ${input.description}`.slice(0, 200)));
  const claimIndex = steps.length;
  steps.push({
    method: "POST",
    path: "/api/v1/expenses/claims/",
    body: json({
      claim_date: input.claimDate,
      purpose: input.purpose,
      lines: [
        {
          category: input.category,
          expense_date: input.claimDate,
          description: input.description,
          amount: input.amount,
          ...(input.receipt ? { receipt_reference: { $ref: "0.id" } } : {}),
        },
      ],
    }),
  });
  steps.push({
    method: "POST",
    path: `/api/v1/expenses/claims/{${claimIndex}.id}/submit/`,
    body: json({ version: { $ref: `${claimIndex}.version` } }),
  });
  return steps;
}

export function decideApproval(requestId: string, version: number, approve: boolean, comment: string): Steps {
  return [
    { method: "POST", path: `/api/v1/approvals/requests/${requestId}/${approve ? "approve" : "reject"}/`, body: json({ version, comment }) },
  ];
}

/** Decimal-string validation without floats: up to 6 decimals, positive (or zero when allowed). */
export function isQuantity(value: string, allowZero = false): boolean {
  if (!/^\d{1,14}(\.\d{1,6})?$/.test(value.trim())) return false;
  return allowZero || /[1-9]/.test(value);
}

export function isMoney(value: string): boolean {
  return /^\d{1,16}(\.\d{1,2})?$/.test(value.trim()) && /[1-9]/.test(value);
}

export const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
