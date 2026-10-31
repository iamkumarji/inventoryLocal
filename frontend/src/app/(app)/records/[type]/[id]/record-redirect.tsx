"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

import { EmptyState } from "@/components/erp/states";

/** Resource type (as used in comments, mentions and audit) → the screen that shows that record. */
const ROUTES: Record<string, string> = {
  "procurement.purchase_requisition": "/procurement/requisitions",
  "procurement.rfq": "/procurement/rfqs",
  "procurement.purchase_order": "/procurement/orders",
  "procurement.goods_receipt": "/procurement/receipts",
  "procurement.purchase_return": "/procurement/receipts/returns",
  "sales.quotation": "/sales/orders/quotations",
  "sales.sales_order": "/sales/orders",
  "sales.delivery": "/sales/deliveries",
  "sales.invoice": "/sales/invoices",
  "sales.sales_return": "/sales/invoices/returns",
  "logistics.shipment": "/logistics/shipments",
  "inventory.stock_adjustment": "/inventory/adjustments",
  "inventory.stock_transfer": "/inventory/transfers",
  "inventory.stock_count": "/inventory/counts",
  "masterdata.item": "/masterdata/items",
  "partners.partner": "/partners/suppliers",
  "manufacturing.production_order": "/manufacturing/orders",
  "manufacturing.bom": "/manufacturing/boms",
  "finance.journal_entry": "/finance/journals",
  "finance.supplier_invoice": "/finance/payables",
  "finance.payment": "/finance/payments",
  "assets.asset": "/assets",
  "assets.depreciation_run": "/assets/depreciation",
  "assets.work_order": "/assets/work-orders",
  "collaboration.task": "/collaboration/tasks",
  "documents.document": "/documents",
  "hr.employee": "/hr/employees",
  "hr.leave_request": "/hr/leave-requests",
  "hr.payroll_run": "/hr/payroll-runs",
  "expenses.expense_claim": "/expenses/claims",
  "expenses.employee_advance": "/expenses/advances",
  "approvals.approval_request": "/approvals",
};

export function RecordRedirect() {
  const { type, id } = useParams<{ type: string; id: string }>();
  const router = useRouter();
  const base = ROUTES[decodeURIComponent(type)];
  useEffect(() => {
    if (base) router.replace(`${base}/${id}`);
  }, [base, id, router]);
  if (base) return null;
  return <EmptyState title="This record can't be opened here" description="There is no screen for this kind of record yet." />;
}
