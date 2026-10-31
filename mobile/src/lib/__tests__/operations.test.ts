import { qty } from "../format";
import { resolveStep } from "../queue/core";
import { deliveryProof, expenseClaim, isMoney, isQuantity, receiveGoods } from "../operations";

const key = (s: object) => ({ ...s, idempotencyKey: "k" }) as Parameters<typeof resolveStep>[0];

test("expense claim links the uploaded receipt and submits the created claim", () => {
  const steps = expenseClaim({
    claimDate: "2026-10-31",
    purpose: "Site visit",
    category: "cat1",
    description: "Diesel",
    amount: "1200.50",
    receipt: { uri: "file:///r.jpg", name: "r.jpg", type: "image/jpeg" },
  });
  expect(steps.map((s) => s.path)).toEqual([
    "/api/v1/documents/documents/",
    "/api/v1/expenses/claims/",
    "/api/v1/expenses/claims/{1.id}/submit/",
  ]);
  const results = [{ id: "doc9" }, { id: "claim7", version: 1 }];
  const create = resolveStep(key(steps[1]), results);
  expect((create.body as { value: { lines: { receipt_reference: string }[] } }).value.lines[0].receipt_reference).toBe("doc9");
  const submit = resolveStep(key(steps[2]), results);
  expect(submit).toEqual({ path: "/api/v1/expenses/claims/claim7/submit/", body: { kind: "json", value: { version: 1 } } });
});

test("expense claim without receipt has no upload step", () => {
  const steps = expenseClaim({ claimDate: "2026-10-31", purpose: "p", category: "c", description: "d", amount: "10", receipt: null });
  expect(steps[1].path).toBe("/api/v1/expenses/claims/{0.id}/submit/");
});

test("delivery proof uses the uploaded signed note as the signature document", () => {
  const steps = deliveryProof({
    shipment: "s1",
    delivery: "d1",
    outcome: "delivered",
    receivedBy: "Reception",
    receivedAt: "2026-10-31T10:00:00Z",
    signedNote: { uri: "file:///n.jpg", name: "n.jpg", type: "image/jpeg" },
    latitude: "18.520400",
    longitude: "73.856700",
    remarks: "",
  });
  expect(steps[0].body).toMatchObject({ kind: "file", fields: { resource_type: "logistics.shipment", resource_id: "s1" } });
  const proof = resolveStep(key(steps[1]), [{ id: "doc1" }]);
  expect(proof.body).toMatchObject({ value: { signature_document_id: "doc1", latitude: "18.520400" } });
});

test("goods receipt posts the receipt it created at that receipt's version", () => {
  const steps = receiveGoods({
    purchaseOrder: "po",
    warehouse: "wh",
    receiptDate: "2026-10-31",
    deliveryNote: "DN-1",
    vehicle: "",
    lines: [{ po_line: "l1", quantity: "5" }],
  });
  expect(resolveStep(key(steps[1]), [{ id: "g1", version: 2 }])).toEqual({
    path: "/api/v1/procurement/receipts/g1/post/",
    body: { kind: "json", value: { version: 2 } },
  });
});

test("quantity and money validation is decimal-string based", () => {
  expect(isQuantity("12.5")).toBe(true);
  expect(isQuantity("0")).toBe(false);
  expect(isQuantity("0", true)).toBe(true);
  expect(isQuantity("1.1234567")).toBe(false);
  expect(isQuantity("-1")).toBe(false);
  expect(isMoney("1200.50")).toBe(true);
  expect(isMoney("12.345")).toBe(false);
  expect(isMoney("0.00")).toBe(false);
});

test("quantities display without trailing zeros", () => {
  expect([qty("250.000000"), qty("12.500"), qty("0.000000"), qty("7"), qty(null)]).toEqual(["250", "12.5", "0", "7", "—"]);
});
