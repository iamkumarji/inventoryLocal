import {
  ArrowLeftRight,
  BadgeCheck,
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  Building2,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  Cog,
  Factory,
  FileSpreadsheet,
  FileText,
  Flag,
  FolderOpen,
  GitBranch,
  Handshake,
  Home,
  Inbox,
  KeyRound,
  Landmark,
  LineChart,
  ListChecks,
  ListTodo,
  type LucideIcon,
  Package,
  PackageCheck,
  Receipt,
  ReceiptIndianRupee,
  Scale,
  ScrollText,
  ShieldCheck,
  ShoppingCart,
  Split,
  Tags,
  Truck,
  UserRound,
  Users,
  Wallet,
  Waypoints,
  Webhook,
  Wrench,
} from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Shown when the user holds ANY of these permissions (empty = every signed-in user). */
  anyOf?: readonly string[];
  /** Shown only when this feature flag is enabled for the user. */
  flag?: string;
  /** Extra words for the command palette. */
  keywords?: string;
  /**
   * Who the item is for. Tenant users work inside an organization; platform operators run the hosting
   * platform, belong to no organization and hold no permissions. Defaults to "tenant".
   */
  audience?: "tenant" | "operator" | "all";
};

export type NavSection = { label: string; items: NavItem[] };

/**
 * Navigation is rendered from the caller's effective permissions and flags.
 * Hiding is cosmetic; the API enforces every decision.
 */
export const NAVIGATION: NavSection[] = [
  {
    label: "Workspace",
    items: [
      { label: "Home", href: "/", icon: Home, audience: "all" },
      { label: "Approvals", href: "/approvals", icon: ClipboardCheck, keywords: "inbox requests decide" },
      { label: "Notifications", href: "/notifications", icon: Bell, audience: "all" },
    ],
  },
  {
    label: "Platform",
    items: [
      { label: "Organizations", href: "/platform", icon: Building2, audience: "operator",
        keywords: "tenants provision suspend reactivate platform console" },
    ],
  },
  {
    label: "My work",
    items: [
      { label: "My tasks", href: "/tasks", icon: ListTodo, flag: "module.collaboration", keywords: "assigned todo" },
      { label: "My leave", href: "/me/leave", icon: CalendarDays, flag: "module.hr", keywords: "holiday absence" },
      { label: "My payslips", href: "/me/payslips", icon: Receipt, flag: "module.hr", keywords: "salary pay" },
      { label: "My expenses", href: "/me/expenses", icon: Wallet, flag: "module.expenses",
        keywords: "claims reimbursement advance" },
    ],
  },
  {
    label: "Insights",
    items: [
      { label: "Dashboards", href: "/analytics", icon: BarChart3, flag: "module.analytics",
        anyOf: ["analytics.dashboard.read"], keywords: "kpi otif dso dpo turns yield" },
      { label: "Report exports", href: "/analytics/reports", icon: FileSpreadsheet, flag: "module.analytics",
        anyOf: ["analytics.report.read"], keywords: "csv download" },
      { label: "Demand forecast", href: "/analytics/forecast", icon: LineChart, flag: "module.analytics",
        anyOf: ["analytics.forecast.read"], keywords: "moving average smoothing" },
    ],
  },
  {
    label: "Inventory",
    items: [
      { label: "Stock on hand", href: "/inventory/stock", icon: Boxes, flag: "module.inventory",
        anyOf: ["inventory.stock_balance.read"], keywords: "availability valuation ageing scan" },
      { label: "Stock ledger", href: "/inventory/ledger", icon: BookOpen, flag: "module.inventory",
        anyOf: ["inventory.stock_ledger.read"], keywords: "movements history" },
      { label: "Adjustments", href: "/inventory/adjustments", icon: Scale, flag: "module.inventory",
        anyOf: ["inventory.stock_adjustment.read"], keywords: "write off found loss" },
      { label: "Transfers", href: "/inventory/transfers", icon: ArrowLeftRight, flag: "module.inventory",
        anyOf: ["inventory.stock_transfer.read"], keywords: "move dispatch receive" },
      { label: "Stock counts", href: "/inventory/counts", icon: ClipboardList, flag: "module.inventory",
        anyOf: ["inventory.stock_count.read"], keywords: "cycle count physical" },
      { label: "Items", href: "/masterdata/items", icon: Package, flag: "module.masterdata",
        anyOf: ["masterdata.item.read"], keywords: "materials products sku" },
      { label: "Item setup", href: "/masterdata/setup", icon: Tags, flag: "module.masterdata",
        anyOf: ["masterdata.uom.read", "masterdata.item_category.read", "masterdata.hsn_code.read"],
        keywords: "uom units categories hsn gst" },
    ],
  },
  {
    label: "Buying",
    items: [
      { label: "Suppliers", href: "/partners/suppliers", icon: Handshake, flag: "module.partners",
        anyOf: ["partners.supplier.read"], keywords: "vendors" },
      { label: "Requisitions", href: "/procurement/requisitions", icon: Inbox, flag: "module.procurement",
        anyOf: ["procurement.purchase_requisition.read"], keywords: "pr indent" },
      { label: "RFQs", href: "/procurement/rfqs", icon: FileText, flag: "module.procurement",
        anyOf: ["procurement.rfq.read"], keywords: "quotations comparison" },
      { label: "Purchase orders", href: "/procurement/orders", icon: ShoppingCart, flag: "module.procurement",
        anyOf: ["procurement.purchase_order.read"], keywords: "po" },
      { label: "Goods receipts", href: "/procurement/receipts", icon: PackageCheck, flag: "module.procurement",
        anyOf: ["procurement.goods_receipt.read", "procurement.purchase_return.read"], keywords: "grn returns" },
      { label: "MRP", href: "/procurement/mrp", icon: Cog, flag: "module.procurement",
        anyOf: ["procurement.mrp.read"], keywords: "planning reorder suggestions" },
      { label: "Quality", href: "/quality", icon: BadgeCheck, flag: "module.quality",
        anyOf: ["quality.inspection.read", "quality.ncr.read"], keywords: "inspection qc ncr" },
    ],
  },
  {
    label: "Production",
    items: [
      { label: "Production orders", href: "/manufacturing/orders", icon: Factory, flag: "module.manufacturing",
        anyOf: ["manufacturing.production_order.read"], keywords: "work orders shop floor" },
      { label: "Bills of materials", href: "/manufacturing/boms", icon: GitBranch, flag: "module.manufacturing",
        anyOf: ["manufacturing.bom.read"], keywords: "bom routing recipe" },
      { label: "Work centres", href: "/manufacturing/work-centers", icon: Cog, flag: "module.manufacturing",
        anyOf: ["manufacturing.work_center.read"], keywords: "machines rates" },
    ],
  },
  {
    label: "Selling",
    items: [
      { label: "Customers", href: "/partners/customers", icon: UserRound, flag: "module.partners",
        anyOf: ["partners.customer.read"], keywords: "clients credit" },
      { label: "Sales orders", href: "/sales/orders", icon: ShoppingCart, flag: "module.sales",
        anyOf: ["sales.sales_order.read", "sales.quotation.read"], keywords: "so quotations credit" },
      { label: "Deliveries", href: "/sales/deliveries", icon: PackageCheck, flag: "module.sales",
        anyOf: ["sales.delivery.read"], keywords: "dispatch" },
      { label: "Sales invoices", href: "/sales/invoices", icon: ReceiptIndianRupee, flag: "module.sales",
        anyOf: ["sales.invoice.read", "sales.sales_return.read"], keywords: "gst credit notes returns" },
      { label: "Shipments", href: "/logistics/shipments", icon: Truck, flag: "module.logistics",
        anyOf: ["logistics.shipment.read", "logistics.vehicle.read", "logistics.driver.read"],
        keywords: "vehicles drivers proof of delivery" },
    ],
  },
  {
    label: "Finance",
    items: [
      { label: "Statements", href: "/finance/reports", icon: BarChart3, flag: "module.finance",
        anyOf: ["finance.report.read"], keywords: "trial balance profit loss balance sheet ledger" },
      { label: "Journals", href: "/finance/journals", icon: BookOpen, flag: "module.finance",
        anyOf: ["finance.journal_entry.read"], keywords: "gl entries" },
      { label: "Payables", href: "/finance/payables", icon: Receipt, flag: "module.finance",
        anyOf: ["finance.supplier_invoice.read", "finance.open_item.read"], keywords: "ap supplier invoices ageing" },
      { label: "Receivables", href: "/finance/receivables", icon: ReceiptIndianRupee, flag: "module.finance",
        anyOf: ["finance.open_item.read"], keywords: "ar ageing customers" },
      { label: "Payments", href: "/finance/payments", icon: Wallet, flag: "module.finance",
        anyOf: ["finance.payment.read"], keywords: "receipts" },
      { label: "Banking", href: "/finance/bank", icon: Landmark, flag: "module.finance",
        anyOf: ["finance.bank_account.read"], keywords: "statement reconciliation" },
      { label: "GST", href: "/finance/gst", icon: FileSpreadsheet, flag: "module.finance",
        anyOf: ["finance.gst.read"], keywords: "gstr1 gstr3b tax" },
      { label: "Budgets", href: "/finance/budgets", icon: Scale, flag: "module.finance",
        anyOf: ["finance.budget.read"], keywords: "variance" },
      { label: "Accounting setup", href: "/finance/setup", icon: Cog, flag: "module.finance",
        anyOf: ["finance.account.read", "finance.posting_rule.read", "finance.period.read"],
        keywords: "chart of accounts posting rules period close cost centres" },
    ],
  },
  {
    label: "People",
    items: [
      { label: "Employees", href: "/hr/employees", icon: Users, flag: "module.hr", anyOf: ["hr.employee.read"] },
      { label: "Attendance", href: "/hr/attendance", icon: CalendarDays, flag: "module.hr",
        anyOf: ["hr.attendance.read"] },
      { label: "Leave", href: "/hr/leave", icon: CalendarDays, flag: "module.hr",
        anyOf: ["hr.leave_request.read", "hr.leave_type.read"], keywords: "requests balances" },
      { label: "Payroll", href: "/hr/payroll", icon: Landmark, flag: "module.hr",
        anyOf: ["hr.payroll_run.read", "hr.salary_structure.read"], keywords: "salary payslips structures" },
      { label: "Expense claims", href: "/expenses", icon: Wallet, flag: "module.expenses",
        anyOf: ["expenses.expense_claim.read", "expenses.employee_advance.read", "expenses.fuel_log.read"],
        keywords: "advances fuel reimbursement" },
    ],
  },
  {
    label: "Assets & files",
    items: [
      { label: "Fixed assets", href: "/assets", icon: Building2, flag: "module.assets",
        anyOf: ["assets.asset.read"], keywords: "register capitalise dispose" },
      { label: "Depreciation", href: "/assets/depreciation", icon: LineChart, flag: "module.assets",
        anyOf: ["assets.depreciation_run.read"] },
      { label: "Maintenance", href: "/assets/maintenance", icon: Wrench, flag: "module.assets",
        anyOf: ["assets.work_order.read", "assets.maintenance_plan.read"], keywords: "work orders preventive" },
      { label: "Tasks", href: "/collaboration/tasks", icon: ListChecks, flag: "module.collaboration",
        anyOf: ["collaboration.task.read"], keywords: "team escalation" },
      { label: "Documents", href: "/documents", icon: FolderOpen, flag: "module.documents",
        anyOf: ["documents.document.read"], keywords: "files attachments" },
    ],
  },
  {
    label: "Access control",
    items: [
      { label: "Users", href: "/admin/users", icon: Users, anyOf: ["identity.user.read"], keywords: "people accounts" },
      { label: "Roles", href: "/admin/roles", icon: KeyRound, anyOf: ["authorization.role.read"], keywords: "permissions" },
      { label: "Access grants", href: "/admin/access", icon: Waypoints, anyOf: ["authorization.role_assignment.read"],
        keywords: "role assignments scope" },
      { label: "Policies", href: "/admin/policies", icon: ShieldCheck, anyOf: ["authorization.policy.read"],
        keywords: "abac rules deny allow" },
      { label: "Sign-in security", href: "/admin/security", icon: ShieldCheck, anyOf: ["organization.organization.read"],
        keywords: "mfa two-step 2fa authenticator otp" },
      { label: "Segregation of duties", href: "/admin/sod", icon: Split, anyOf: ["authorization.sod_rule.read"],
        keywords: "sod conflicts maker checker" },
    ],
  },
  {
    label: "Approvals setup",
    items: [
      { label: "Approval routes", href: "/admin/approval-routes", icon: GitBranch,
        anyOf: ["approvals.approval_matrix.read"], keywords: "matrix levels workflow" },
      { label: "Approval limits", href: "/admin/approval-limits", icon: Scale,
        anyOf: ["authorization.approval_limit.read"], keywords: "amount thresholds" },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Organization", href: "/admin/organization", icon: Building2,
        anyOf: ["organization.company.read", "organization.branch.read", "organization.warehouse.read",
                "organization.facility.read", "organization.department.read"],
        keywords: "companies branches plants warehouses departments" },
      { label: "Feature flags", href: "/admin/feature-flags", icon: Flag, anyOf: ["core.feature_flag.read"] },
      { label: "Audit log", href: "/admin/audit", icon: ScrollText, anyOf: ["audit.audit_event.read"],
        keywords: "history trail events" },
      { label: "Event outbox", href: "/admin/outbox", icon: ListChecks, anyOf: ["core.outbox_event.read"],
        keywords: "dead letter retry" },
      { label: "Webhooks", href: "/admin/webhooks", icon: Webhook, flag: "module.integrations",
        anyOf: ["integrations.webhook.read"], keywords: "integrations callbacks events signing secret deliveries" },
    ],
  },
];

export function visibleNavigation(
  canAny: (codes: readonly string[]) => boolean,
  flag: (k: string) => boolean,
  isOperator = false,
) {
  const forAudience = (item: NavItem) => {
    const audience = item.audience ?? "tenant";
    return audience === "all" || (audience === "operator") === isOperator;
  };
  return NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => forAudience(item) && canAny(item.anyOf ?? []) && (!item.flag || flag(item.flag)),
    ),
  })).filter((section) => section.items.length > 0);
}

/** Longest-prefix match so /admin/users/123 highlights "Users". */
export function activeHref(pathname: string): string {
  const all = NAVIGATION.flatMap((s) => s.items.map((i) => i.href));
  return all
    .filter((href) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`)))
    .sort((a, b) => b.length - a.length)[0] ?? "/";
}
