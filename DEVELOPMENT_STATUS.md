# Development Status

Last updated: 2026-10-31 | Current state: **all modules built (backend, web, mobile); deep end-to-end testing deferred at the product owner's request** ("testing later, build first").
Legend: ✅ built and verified as stated · 🟡 built, verification partial (see notes) · ⏳ not built · ⛔ blocked

How to read "verified": *backend tests* = pytest on real PostgreSQL through services and the API; *browser-tested* = a Playwright spec drove the screen against a real backend; *built only* = compiles, type-checks and lints, but no test has exercised it.

## Verification snapshot (2026-10-31)
| Gate | Result |
|---|---|
| Backend test suite (PostgreSQL 14) | ✅ 1,343 passed in the last full run (incl. parametrized endpoint-permission matrix over every URL). Tests added afterwards (S3 public-link signing, ops commands) pass individually |
| Lint, layering, migrations, OpenAPI | ✅ `ruff check` clean · `lint-imports` 2 kept / 0 broken · `makemigrations --check` no drift · `spectacular --validate --fail-on-warn` 0 warnings |
| Web app | ✅ `tsc` clean, ESLint clean, `next build` succeeds (113 pages). Browser coverage per module below |
| Mobile app | ✅ `tsc`, `expo lint` clean; 17 unit tests (offline queue, operations). 🟡 Browser-build e2e: storekeeper flow passes; expense, driver and approver flows not yet passing |
| Docker images / CI runner | 🟡 Compose files parse; **images not built** (no Docker daemon here); CI workflow written, **not run on a runner** |
| Backup/restore | 🟡 `backup.sh` ran and produced a verified dump; the restore half of the drill ran but its result is void (the dump was taken while a test reset was rebuilding that database). Needs a clean re-run |

## Modules
| # | Module | Backend | Web screens | Notes / known gaps |
|---|---|---|---|---|
| 1 | Organization, identity, RBAC/ABAC, audit, approvals, notifications | ✅ | ✅ browser-tested (Phase 1b suite) | WebAuthn ⏳ |
| 2 | Master data (items, UoM, categories, HSN) | ✅ | ✅ browser-tested | |
| 3 | Inventory & warehouse (moving average, reservations, batches/serials, adjustments, transfers, blind counts, ageing, scan) | ✅ incl. concurrency test | ✅ browser-tested except edit dialogs, batch/serial lines, bin pickers | Stock list can't filter by stock status; counts have no separate submit step; adjustments have no reject/cancel endpoint; serial items excluded from counts |
| 4 | Suppliers & customers (maker-checker vendor approval, encrypted bank accounts) | ✅ | 🟡 maker side browser-tested; checker side built only | |
| 5 | Procurement (MRP, PR, RFQ, quotations, PO, GRN, QC hold, returns) | ✅ P2P tests | 🟡 built only | Requisition cancel endpoint missing; RFQ quotations not listable separately |
| 6 | Quality (plans, inspections, NCR, supplier rating) | ✅ | ✅ browser-tested | |
| 7 | Manufacturing (BOM versions, routing, production orders, actual costing, scrap, close) | ✅ | 🟡 BOM screens browser-tested; production orders built only | Production order cancel endpoint missing |
| 8 | Sales (quotations, credit check/override, delivery + COGS, GST invoice, returns/credit notes) | ✅ O2C test | 🟡 built only | GST on credit notes uses the invoice's rates (approximation); AR overdue blocks with no grace period |
| 9 | Logistics (vehicles, drivers, shipments, document expiry, POD) | ✅ | 🟡 built only | Freight cost is recorded but not posted to GL |
| 10 | Finance (GL, AP 3-way match, payments, AR, bank import/reconcile, GST returns, budgets, period/year close) | ✅ | 🟡 journals, statements, payments, banking, analytics browser-tested; payables, GST, budgets, close built only | Budget CRUD/approve and apply-credit endpoints added after the screens were built — the screens don't use them yet |
| 11 | Expenses (claims, advances, fuel logs, category policy) | ✅ | 🟡 creation and policy errors browser-tested; decide/pay built only | No `my/advances` endpoint |
| 12 | HR & payroll (employees with masked PII, attendance, leave, salary structures, payroll runs, payslips) | ✅ | ✅ employees, leave, payroll run, payslip privacy browser-tested | Reversal of a posted payroll run not built |
| 13 | Tasks & collaboration (tasks, comments, mentions, escalation) | ✅ | 🟡 built only | |
| 14 | Documents (versions, ACL, legal hold, retention; local or S3/MinIO) | ✅ incl. S3 against an in-process mock | 🟡 built only | Direct-to-S3 upload not wired (uploads go through the API) |
| 15 | Assets & maintenance (capitalisation, depreciation runs, disposal, preventive maintenance, MTBF/MTTR) | ✅ | 🟡 built only | No catch-up depreciation for assets in use before the first run; GST on asset sale not handled |
| 16 | Analytics (role dashboards, KPIs from ledgers, async CSV exports, forecasting) | ✅ | ✅ dashboards + export browser-tested | HR and employee dashboards ⏳ |
| 17 | Integrations (webhooks, e-invoice / e-way bill / bank file adapters) | ⏳ | ⏳ | Not started. The outbox is in place for it |
| — | Mobile app (lookup, GRN, counts, transfers, POD, approvals, expenses, offline outbox) | n/a | 🟡 see snapshot | Native (device) build not made; OCR receipt capture (SRS "could") not built |

## Fixed while building this round
- Period close compared today's sub-ledgers with the GL at the period end date; reconciliation is now as-of dated throughout.
- Duplicate bank statement imports were accepted; overlapping lines are now rejected.
- Report endpoints rendered money as JSON floats; all decimals are now rendered as strings.
- A refused over-receipt left a draft goods receipt behind; tolerance is now checked at creation as well as (authoritatively) at posting.
- **Blind counts leaked system quantities** on the list endpoint; the blind rule now applies per record on every response.
- `master_schema` replaced subclass `create`/`partial_update`, so partner profiles were never created and item stock-unit locks never ran; it now wraps the subclass handlers.
- Feature flags couldn't be switched from the admin screen (500); vendor approval was refused for everyone (missing action mapping); empty RFQs crashed; integrity errors were all reported as "code already exists".
- `workflow.submit` crashed for system contexts (no user).
- Endpoints written by the mobile outbox now all honour `Idempotency-Key` (contract test).
- Own-action denials (self-approval, maker-checker, approval limit, SoD) now say why; other denials stay generic.

## Phase 10 (hardening)
| Item | Status | Notes |
|---|---|---|
| `verify_integrity` (audit chain, balanced journals, sub-ledgers vs GL, stock vs ledger, encrypted values readable) | ✅ | Tested, including detection of corrupted stock and lost keys |
| `rotate_field_keys` (re-encrypt under the new key) | ✅ | Tested old-key retirement |
| Backup script + restore drill | 🟡 | See snapshot; pgBackRest/WAL archiving not rehearsed |
| MinIO bucket init (versioning, least-privilege app user), public signed-link endpoint | 🟡 | Signing tested against a mock; compose not run |
| CSP | 🟡 | Hardened; `'unsafe-inline'` scripts remain because Partial Prerendering can't use nonces — see D-33 |
| Runbooks (deploy, backup/restore, key rotation, incidents, close, access lifecycle) | ✅ written | Not rehearsed |
| Load testing, external security test, e2e in CI, Grafana dashboards, WORM export of audit head, air-gapped Swagger assets | ⏳ | |

## Business decisions still open
See `docs/DECISIONS.md` (⚠ items): valuation (D-01, implemented as moving average), costing (D-02, actual costing), payroll statutory scope (D-12, rates are data, test set labelled TEMPLATE), legacy migration source (D-17), CSP vs prerendering (D-33).

## Next testing pass (when requested)
Re-run the per-module Playwright specs on fresh databases (`frontend/e2e/20-…60-*.spec.ts`; commands in each module's section of the README), finish the mobile e2e flows (`mobile/e2e/run.sh`), a clean restore drill, image builds, and a CI run.
