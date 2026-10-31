# OtabuPro ERP — Software Requirements Specification

Status: **Baseline v1.0**. Requirement IDs are stable and referenced by tests (`@pytest.mark.req("INV-012")`).
Priority: **M** must (go-live), **S** should, **C** could.

## 1. Purpose and scope
An integrated ERP for a manufacturing business with 100–500 users across multiple companies, branches, facilities and warehouses, self-hosted, with web and mobile clients. It covers master data, inventory, procurement, manufacturing, quality, sales, logistics, finance (double-entry with GST), expenses, HR and payroll, collaboration, documents, assets and maintenance, analytics and administration.

Out of scope for v1 (unless decided otherwise, see [DECISIONS](DECISIONS.md)): CRM marketing automation, e-commerce storefront, advanced APS/finite-capacity scheduling, multi-tenant SaaS hosting, consolidation across group companies (designed for later).

## 2. Actors
Management · Finance controller / accountant / AP-AR clerk · Procurement manager / buyer · Warehouse manager / store keeper · Production planner / supervisor / operator · Quality inspector · Sales manager / executive · Logistics coordinator / driver · HR manager / payroll officer · Employee (self-service) · Maintenance technician · Internal auditor · System administrator · External: suppliers (documents only, no portal in v1), customers, GST portal/GSP, banks.

## 3. Functional requirements

### 3.1 Platform foundation (FND)
| ID | Requirement | P |
|---|---|---|
| FND-001 | Manage organization, companies (legal entities with GSTIN/PAN), branches, departments (tree), facilities and warehouses | M |
| FND-002 | Fiscal years and periods per company with per-module period locks | M |
| FND-003 | Gapless document numbering per company, series and fiscal year with configurable prefixes | M |
| FND-004 | Feature flags targeting company, role and user; disabled modules hidden and blocked | M |
| FND-005 | Idempotent processing of critical write APIs via `Idempotency-Key` | M |
| FND-006 | Transactional outbox for domain events with retry and dead-letter handling | M |
| FND-007 | Consistent error model, pagination, filtering, sorting and OpenAPI documentation | M |
| FND-008 | Request tracing with request ID across logs, audit and events | M |

### 3.2 Identity and access (IAM)
| ID | Requirement | P |
|---|---|---|
| IAM-001 | Email + password login with Argon2id hashing and password policy | M |
| IAM-002 | TOTP MFA with recovery codes; enforce per user/role; step-up for sensitive actions | M |
| IAM-003 | Server-side revocable sessions with idle and absolute timeouts; list and revoke sessions | M |
| IAM-004 | Account lockout after configurable failed attempts | M |
| IAM-005 | RBAC with actions create, read, update, delete, approve, reject, post, cancel, export, download, assign, manage | M |
| IAM-006 | Role assignments scoped to organization/company/branch/department/facility/warehouse with validity windows | M |
| IAM-007 | ABAC policies over subject, resource, action and environment attributes; deny overrides | M |
| IAM-008 | Default deny; server-side checks on every endpoint, object, list and field | M |
| IAM-009 | No self-approval of own transactions by default; SoD rules; maker-checker | M |
| IAM-010 | Configurable approval limits by role, document type, company and currency | M |
| IAM-011 | Effective permissions endpoint for UI navigation | M |
| IAM-012 | SSO / LDAP integration | C |

### 3.3 Audit (AUD)
| ID | Requirement | P |
|---|---|---|
| AUD-001 | Append-only audit log of security events, postings, approvals, configuration changes, exports | M |
| AUD-002 | Tamper evidence through a hash chain with verification job | M |
| AUD-003 | Field-level change history (before/after) with sensitive values masked | M |
| AUD-004 | Audit search by actor, resource, action, date; export for auditors | M |

### 3.4 Master data (MDM)
| ID | Requirement | P |
|---|---|---|
| MDM-001 | Items with type, UoMs, tracking mode (none/batch/serial), HSN, shelf life, flags (stocked, purchasable, saleable, manufactured) | M |
| MDM-002 | UoM conversions (global and item-specific) with precise decimals | M |
| MDM-003 | Item categories (tree) driving account determination and reporting | M |
| MDM-004 | Multiple barcodes/QR per item, batch, serial and location | M |
| MDM-005 | Reorder level, min/max, lead time per item × warehouse | M |
| MDM-006 | Price lists (purchase and sales) with validity | S |
| MDM-007 | Import/export of master data with validation preview | S |

### 3.5 Suppliers and customers (PTN)
| ID | Requirement | P |
|---|---|---|
| PTN-001 | Partners with GSTIN validation, PAN, addresses (billing/shipping, state code), contacts | M |
| PTN-002 | Supplier profile: payment terms, approved items, lead times, rating, blocked status | M |
| PTN-003 | Customer profile: credit limit, credit days, price list, blocked status | M |
| PTN-004 | Bank details changes require approval (maker-checker) and are audited | M |

### 3.6 Inventory and warehouse (INV)
| ID | Requirement | P |
|---|---|---|
| INV-001 | Hierarchical locations (zone/rack/bin) per warehouse | M |
| INV-002 | Append-only stock ledger as the single source of truth for quantity and value | M |
| INV-003 | Derived stock balances by item/warehouse/location/batch/status, rebuildable from the ledger | M |
| INV-004 | Batch/lot tracking with manufacturing and expiry dates; FEFO suggestion | M |
| INV-005 | Serial tracking with full movement history | M |
| INV-006 | Stock statuses: unrestricted, quality hold, blocked, in transit | M |
| INV-007 | Reservations against available stock for sales orders and production orders | M |
| INV-008 | Inter-warehouse transfers with in-transit stock and two-step dispatch/receive | M |
| INV-009 | Stock adjustments with reason codes and approval | M |
| INV-010 | Cycle counts and full physical counts with freeze, blind count, recount, approval and variance posting | M |
| INV-011 | Negative stock blocked unless explicitly permitted per warehouse and permission | M |
| INV-012 | Moving weighted average valuation per company × item × warehouse (FIFO optional) | M |
| INV-013 | Stock ageing by receipt date / batch | M |
| INV-014 | Raw material, WIP, finished goods, quarantine, scrap and transit warehouses | M |
| INV-015 | Barcode/QR scanning for receipt, putaway, picking, transfer, count, issue (mobile) | M |
| INV-016 | Every movement posts the matching GL entry in the same transaction | M |

### 3.7 Procurement (PRC) — Procure-to-Pay
| ID | Requirement | P |
|---|---|---|
| PRC-001 | MRP run generating purchase and production suggestions from demand, stock, reservations, open POs and BOMs | M |
| PRC-002 | Purchase requisitions with approval matrix | M |
| PRC-003 | RFQ to multiple suppliers, supplier quotations entry | M |
| PRC-004 | Quotation comparison (price, lead time, terms, rating) with selection justification | M |
| PRC-005 | Purchase orders from requisitions/quotations, approval by amount, amendments as versions | M |
| PRC-006 | GRN against PO with over/under receipt tolerance, batch/serial capture, scanning | M |
| PRC-007 | Quality inspection on receipt; stock in quality hold until accepted | M |
| PRC-008 | Purchase invoice with 2/3-way match (PO, GRN, invoice) and configurable tolerances | M |
| PRC-009 | Purchase returns (to supplier) with stock and debit note posting | M |
| PRC-010 | Payment scheduling and supplier payments posting to AP and bank | M |
| PRC-011 | Landed cost allocation (freight, duty) to receipts | S |
| PRC-012 | Job work / subcontracting with material sent to supplier | S |

### 3.8 Manufacturing (MFG) — Plan-to-Produce
| ID | Requirement | P |
|---|---|---|
| MFG-001 | Multi-level BOM with component quantities, scrap %, UoM, alternates | M |
| MFG-002 | BOM versioning with approval, effective dates and immutable approved versions | M |
| MFG-003 | Work centres with capacity, cost rates (labour, machine, overhead) | M |
| MFG-004 | Routings with operations and standard times | M |
| MFG-005 | Production planning from sales orders/forecast; BOM explosion; material availability check | M |
| MFG-006 | Production orders: release freezes BOM/routing; reserve materials | M |
| MFG-007 | Material issue (manual and backflush) RM → WIP with ledger and GL | M |
| MFG-008 | Operation confirmations (quantity, time, operator) | M |
| MFG-009 | Finished goods / semi-finished receipt to warehouse at actual cost | M |
| MFG-010 | Scrap recording (with scrap warehouse/value) and rework orders | M |
| MFG-011 | Production costing: material + labour + machine + overhead; variances at close | M |
| MFG-012 | In-process quality checks | S |

### 3.9 Quality (QLT)
QLT-001 inspection plans per item/stage (M) · QLT-002 inspections at receipt, in-process, final (M) · QLT-003 accept/reject/partial with stock status movement (M) · QLT-004 NCR and CAPA (S) · QLT-005 supplier quality scorecard (S).

### 3.10 Sales (SLS) — Order-to-Cash
| ID | Requirement | P |
|---|---|---|
| SLS-001 | Sales quotations with validity and conversion to order | M |
| SLS-002 | Sales orders with credit check (limit and overdue), hard or soft block per decision | M |
| SLS-003 | Stock reservation and availability promise | M |
| SLS-004 | Delivery/dispatch with picking, scanning, batch/serial selection | M |
| SLS-005 | GST-compliant sales invoices (gapless numbering, place of supply, CGST/SGST/IGST) | M |
| SLS-006 | Sales returns with stock receipt and credit note | M |
| SLS-007 | Customer receipts with allocation to invoices; AR ageing | M |
| SLS-008 | E-invoice (IRN) and e-way bill generation via GSP | S |

### 3.11 Logistics (LOG)
LOG-001 inbound and outbound shipments (M) · LOG-002 vehicles, drivers, documents and expiry reminders (M) · LOG-003 trip planning and dispatch (M) · LOG-004 proof of delivery with photo, signature, geo-tag, timestamp (M) · LOG-005 freight cost capture and allocation (S).

### 3.12 Finance and accounting (FIN)
| ID | Requirement | P |
|---|---|---|
| FIN-001 | Chart of accounts per company (tree, account types, control accounts) | M |
| FIN-002 | Double-entry GL; balanced, immutable posted journals; reversal-only corrections | M |
| FIN-003 | Configurable posting profiles mapping transactions to accounts | M |
| FIN-004 | Accounts payable: invoices, debit notes, payments, ageing | M |
| FIN-005 | Accounts receivable: invoices, credit notes, receipts, ageing, dunning | M |
| FIN-006 | Cash and bank accounts, payments, receipts, contra | M |
| FIN-007 | Bank statement import and reconciliation (auto-match + manual) | M |
| FIN-008 | GST: tax codes, input/output, reverse charge, GSTR-1 and GSTR-3B data | M |
| FIN-009 | TDS/TCS | S |
| FIN-010 | Cost centres and profit centres on journal lines | M |
| FIN-011 | Budgets with variance reporting and optional budget check on PO | S |
| FIN-012 | Trial balance, P&L, balance sheet, cash flow (indirect), drill-down to source | M |
| FIN-013 | Period close with checklist, sub-ledger to GL reconciliation | M |
| FIN-014 | Multi-currency documents with FX revaluation | C |

### 3.13 Expenses (EXP) — Expense-to-Payment
EXP-001 claims with categories (fuel, petrol, diesel, transport, travel, labour, maintenance, other) and receipt attachments (M) · EXP-002 fuel logs with vehicle, odometer, litres, rate (M) · EXP-003 policy limits per category/grade (configurable) (M) · EXP-004 approval matrix, no self-approval (M) · EXP-005 advances and settlement (M) · EXP-006 reimbursement payment and journal posting to cost centre (M) · EXP-007 mobile capture with OCR (C).

### 3.14 HR and payroll (HR)
HR-001 employee records linked to users and departments (M) · HR-002 attendance (manual, biometric import) and shifts (M) · HR-003 leave types, balances, requests and approval (M) · HR-004 salary structures and components (M) · HR-005 payroll runs with approval and GL posting (M) · HR-006 salary data restricted to `hr.salary.*` with MFA and audit (M) · HR-007 statutory deductions PF/ESI/PT/TDS per decision (S) · HR-008 employee self-service (payslips, leave, attendance) (M).

### 3.15 Collaboration (COL)
COL-001 tasks with assignment, due dates, priority, status (M) · COL-002 comments with @mentions on any record (permission-checked) (M) · COL-003 in-app, email, push notifications with preferences (M) · COL-004 escalation rules on overdue approvals and tasks (M) · COL-005 activity timeline per record (M).

### 3.16 Documents (DOC)
DOC-001 upload to MinIO with type and size validation (M) · DOC-002 versioning (M) · DOC-003 access control inherited from linked record plus explicit ACL (M) · DOC-004 retention and legal hold (S) · DOC-005 virus scan (S).

### 3.17 Assets and maintenance (AST)
AST-001 asset register with location, custodian, cost (M) · AST-002 depreciation (SLM/WDV, per Companies Act and IT Act books as decided) (M) · AST-003 preventive maintenance plans by time/meter (M) · AST-004 breakdown work orders, spare consumption from inventory (M) · AST-005 downtime and MTBF/MTTR reporting (S).

### 3.18 Analytics (ANL)
ANL-001 role-specific dashboards (management, finance, procurement, production, warehouse, sales, HR, employee) (M) · ANL-002 standard reports with filters, export by permission (M) · ANL-003 async report generation (M) · ANL-004 KPIs: inventory turns, OTIF, yield, scrap %, DSO, DPO, cash position, budget variance (M) · ANL-005 demand forecasting (moving average / exponential smoothing) (S).

### 3.19 Administration and integrations (ADM)
ADM-001 user, role, policy, flag and number-series management (M) · ADM-002 webhooks on domain events (S) · ADM-003 data import framework (M) · ADM-004 system health and job monitoring (M) · ADM-005 backup status visibility (S).

## 4. End-to-end workflows (acceptance)
Each workflow has an automated API-level scenario test asserting documents, stock ledger, balances and GL.

1. **Procure-to-Pay**: PR → approval → RFQ → quotations → comparison → PO → approval → GRN (quality hold) → inspection accept → purchase invoice 3-way match → payment approval → payment → ledger checks (Inventory Dr / GR-IR Cr; GR-IR Dr / AP Cr; AP Dr / Bank Cr).
2. **Plan-to-Produce**: demand → production plan → BOM explosion → availability → reservation → production order release → material issue → operation confirmation → in-process QC → FG receipt → close → costing variances.
3. **Order-to-Cash**: quotation → SO → credit check → reservation → pick/dispatch → delivery (COGS) → invoice (AR, GST) → POD → receipt → reconciliation.
4. **Expense-to-Payment**: claim with receipts → approval (not self) → payment → journal to cost centre; advance settlement.

## 5. Non-functional requirements
| ID | Requirement |
|---|---|
| NFR-001 | p95 API latency < 300 ms (reads) and < 800 ms (postings) at 150 concurrent users |
| NFR-002 | 99.5% availability in business hours; RPO ≤ 15 min; RTO ≤ 4 h |
| NFR-003 | OWASP ASVS Level 2; TLS 1.2+; encrypted sensitive fields |
| NFR-004 | WCAG 2.1 AA; responsive desktop/tablet/mobile |
| NFR-005 | All posted transactions immutable; reversals only |
| NFR-006 | Full audit trail retained ≥ 8 years |
| NFR-007 | Test coverage ≥ 85% for domain/services; every workflow has E2E tests |
| NFR-008 | Zero-downtime deploys for non-migration releases; backward-compatible migrations |
| NFR-009 | Localization-ready (English first; INR formatting, Indian numbering lakh/crore) |
| NFR-010 | Mobile scanning works on intermittent connectivity with idempotent replay |
