# OtabuPro ERP — Business Decisions Register

These are business decisions that the requirements leave open. Each has a **working assumption** so development can continue; assumptions are implemented as **configuration** wherever possible, so changing them later means changing data, not rewriting code. Items marked ⚠ affect data structures or accounting and should be confirmed before the listed phase.

| ID | Decision needed | Working assumption | Needed by | Impact if changed |
|---|---|---|---|---|
| D-01 ⚠ | Inventory valuation method | Moving weighted average per company × item × warehouse; FIFO designed as option | Phase 2 | Valuation engine and layers table |
| D-02 ⚠ | Production costing: actual vs standard | Actual costing (material at issue cost + work-centre rates × confirmed time + overhead rate); variances vs standard reported | Phase 4 | Costing engine, GL accounts |
| D-03 ⚠ | Fiscal year and base currency | April–March, INR base; foreign currency on purchase documents is Phase 5+ (FIN-014 "could") | Phase 1 (fiscal calendar) | Period generation |
| D-04 ⚠ | Number of legal entities and GSTINs; one GSTIN per state branch? | Multiple companies supported; GSTIN at company and branch level | Phase 1 | Org model (already supports both) |
| D-05 | Negative stock policy | Blocked everywhere; a warehouse may allow it only with flag + `inventory.stock.negative_override` permission | Phase 2 | Config only |
| D-06 | Material issue mode | Both manual issue and backflush, configured per BOM component / work centre | Phase 4 | Config only |
| D-07 | Credit limit enforcement | Hard block on order approval when limit or overdue days exceeded; override with `sales.sales_order.credit_override` + approval | Phase 5 | Config only |
| D-08 | 3-way match tolerances | Quantity 0%, price ±2% or ₹500 per line (configurable per supplier/category) | Phase 3/5 | Config only |
| D-09 | Approval matrix (levels, amounts) | None hardcoded; seed example: PO ≤ ₹1 L buyer manager, ≤ ₹10 L procurement head, > ₹10 L director (labelled demo data) | Phase 1b | Config only |
| D-10 | GST e-invoicing and e-way bill | Required if turnover thresholds apply; implemented as integrations adapter via a GSP chosen by the business | Phase 5 | Integration vendor selection |
| D-11 | TDS/TCS applicability | Designed; implemented in Phase 5 as "should" | Phase 5 | Tax engine |
| D-12 ⚠ | Payroll statutory scope (PF, ESI, PT by state, LWF, income-tax TDS) and states of operation | Component-based salary engine; statutory rules as configurable formulas; state list to be provided | Phase 6 | Payroll rules |
| D-13 | Attendance source | Manual + CSV/biometric device import | Phase 6 | Adapter |
| D-14 | Batch expiry policy (FEFO enforce vs suggest) | Suggest FEFO; block issue of expired batches | Phase 2 | Config |
| D-15 | Which items are serial-tracked | Configured per item; serial capture mandatory at receipt and issue | Phase 2 | Config |
| D-16 | Barcode symbologies and label printers | Code 128 for items/locations, QR for batches/serials/documents; ZPL label templates for Zebra printers | Phase 2/9 | Label templates |
| D-17 ⚠ | Legacy system and opening balances (e.g. Tally) | Import tool for masters, opening stock (by batch) and opening GL/AR/AP balances at a cut-over date | Phase 10 | Migration tooling |
| D-18 | Bank integration | Statement import (CSV/MT940/CAMT.053) and payment file export per bank format | Phase 5 | Adapter |
| D-19 | Data retention | 8 years for financial, GST and audit records | Phase 1 | Purge policies |
| D-20 | SSO / Active Directory | Not in v1; local accounts + MFA; LDAP/SAML/OIDC adapter later | — | Auth adapter |
| D-21 | Notification channels | In-app + email (SMTP) in v1; SMS/WhatsApp provider to be chosen | Phase 7 | Adapter |
| D-22 | Languages | English UI, i18n-ready | — | Translations |
| D-23 | Mobile offline depth | Offline queue for scanning transactions; no offline master-data editing | Phase 9 | Sync design |
| D-24 | Sentry hosting | Self-hosted Sentry is heavy; default to GlitchTip (Sentry-protocol compatible) on the ops VM, or Sentry SaaS if data policy allows | Phase 10 | Ops |
| D-25 | Fixed-asset depreciation books | Companies Act (SLM/WDV per Schedule II) as primary book; IT Act book as secondary | Phase 7 | Asset books |
| D-26 | Job work / subcontracting | Designed (PRC-012, "should"); includes ITC-04 data | Phase 3+ | Procurement + inventory |
| D-27 | Inter-company transactions (stock transfer between own GSTINs) | Treated as taxable supply when GSTINs differ (branch transfer invoice) | Phase 5 | Transfer + tax logic |
| D-28 | Session timeouts and MFA enforcement scope | Idle 30 min, absolute 12 h; MFA enforced for finance, HR/payroll, admin and approver roles | Phase 1 | Config |
| D-29 | Self-approval exceptions (e.g. small-company owner) | None by default; explicit `*.self_approve` grant with MFA if the business wants it | Phase 1 | Config |
| D-31 | Multi-level approval and limits | Limits apply at the final step; earlier steps endorse. Each person decides at most one step; delegates act with the delegator's authority and never on their own requests | Phase 1b (done) | Config + engine rule |
| D-32 | Delegation window | Maximum 90 days per delegation; all document types unless restricted | Phase 1b (done) | Constant in service; make configurable if needed |
| D-33 | Content Security Policy | Nonce-based CSP is **not possible** while Partial Prerendering (`cacheComponents`) is on: Next.js 16 documents PPR as incompatible with nonces, because static shells are built before any request. Decision: keep PPR; `script-src 'self' 'unsafe-inline'`, with every other directive locked (`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, no third-party origins). Compensating controls: no `dangerouslySetInnerHTML`/`eval` in the codebase, React output escaping, HttpOnly session cookies plus CSRF tokens. Revisit if the business prefers strict CSP over prerendering (turn off `cacheComponents`, add a `proxy.ts` nonce) | Phase 10 | Security lead |
| D-34 | Multi-tenancy model | Several organizations per installation with logical isolation (shared database, per-organization data, grants, flags and references; platform operators outside every tenant). Separate installation for customers who need physical isolation | Done (2026-10-31) | Product owner chose multi-tenant SaaS |
| D-30 | Report replica | Use a streaming replica for analytics if available; otherwise primary with statement timeouts | Phase 8 | Ops |
