# Development Status

Last updated: 2026-11-01 | Current state: **all modules built and browser-tested end to end** (backend, web, mobile). Remaining gaps listed per module and under "Not yet done".
Legend: ✅ built and verified as stated · 🟡 built, verification partial (see notes) · ⏳ not built · ⛔ blocked

How to read "verified": *backend tests* = pytest on real PostgreSQL through services and the API; *browser-tested* = a Playwright spec drove the screen against a real backend (fresh database, real Celery worker, console errors fail the test, every screen checked at 375 px for horizontal scroll).

## Verification snapshot (2026-11-01)
| Gate | Result |
|---|---|
| Backend test suite (PostgreSQL 14) | ✅ 1,440 passed (incl. endpoint-permission matrix over every URL and the multi-tenant isolation crawl) |
| Lint, layering, migrations, OpenAPI | ✅ `ruff check` + `ruff format --check` clean · `lint-imports` 2 kept / 0 broken · no migration drift · `spectacular --validate --fail-on-warn` 0 warnings |
| Web app | ✅ `tsc`, ESLint clean; `next build` succeeds (120 pages) |
| Web end-to-end (Playwright, Chromium) | ✅ every suite green in one run on a freshly reset database: core admin/approvals/platform/security/webhooks 8/8 · inventory, master data, quality 11/11 · buying, selling, logistics 7/7 · finance & analytics 15/15 · production, assets, tasks, documents 8/8 · HR, payroll, expenses 8/8 (each suite includes `01-admin-first-login`) |
| Mobile app | ✅ `tsc`, `expo lint` clean; 18 unit tests; browser-build e2e 4/4 at phone size (storekeeper incl. lost-response replay and offline count, employee expense with receipt photo, driver proof of delivery with photo and location, approver) |
| Docker images / CI runner | 🟡 Compose files parse; **images not built** (no Docker daemon here); CI workflow written, **not run on a runner**; e2e not in CI yet |
| Backup/restore | 🟡 `backup.sh` produced a verified dump; a clean restore drill still has to be re-run |

## Modules
| # | Module | Backend | Web screens | Notes / known gaps |
|---|---|---|---|---|
| 1 | Organization, identity, RBAC/ABAC, audit, approvals, notifications | ✅ | ✅ browser-tested | WebAuthn ⏳ |
| 2 | Master data (items, UoM, conversions, categories, HSN) | ✅ | ✅ browser-tested incl. edit dialogs and conflicts | No bin-management screen (bins via API) |
| 3 | Inventory & warehouse (moving average, reservations, batches/serials, adjustments incl. cancel, transfers, blind counts, ageing, scan) | ✅ incl. concurrency test | ✅ browser-tested incl. batch/serial/bin lines | Stock list can't filter by stock status; counts have no separate submit step; transfer/count cancel not available; serial items excluded from counts |
| 4 | Suppliers & customers (maker-checker vendor approval, encrypted bank accounts) | ✅ | ✅ browser-tested (maker and checker) | |
| 5 | Procurement (MRP, PR incl. cancel, RFQ, quotations, PO, GRN, QC hold, returns) | ✅ | ✅ browser-tested | RFQ quotations not listable separately |
| 6 | Quality (plans, inspections, NCR, supplier rating) | ✅ | ✅ browser-tested (final-stage inspections) | Receipt-stage inspection reached through GRN flow only |
| 7 | Manufacturing (BOM versions, routing, production orders, actual costing, scrap, close, cancel) | ✅ | ✅ browser-tested | Rework orders and meter-triggered plans not driven in the browser |
| 8 | Sales (quotations, credit check/override, delivery + COGS, GST invoice, returns/credit notes) | ✅ | ✅ browser-tested | GST on credit notes uses the invoice's rates (approximation); AR overdue blocks with no grace period |
| 9 | Logistics (vehicles, drivers, shipments, document expiry, POD) | ✅ | ✅ browser-tested | Freight cost recorded but not posted to GL; refused/partial POD not driven in the browser |
| 10 | Finance (GL, AP 3-way match, payments, apply credit, AR, bank import/reconcile, GST returns, budgets, period/year close) | ✅ | ✅ browser-tested incl. step-up prompt | Statement file upload (paste is tested); forced close with differences not exercised |
| 11 | Expenses (claims, advances, fuel logs, category policy, rejection reasons) | ✅ | ✅ browser-tested | |
| 12 | HR & payroll (employees with masked PII, attendance, leave, salary structures, payroll runs incl. reversal, payslips) | ✅ | ✅ browser-tested | |
| 13 | Tasks & collaboration (tasks, comments, mentions, escalation) | ✅ | ✅ browser-tested incl. mention links | |
| 14 | Documents (versions, ACL, legal hold, retention; local or S3/MinIO) | ✅ incl. S3 against an in-process mock | ✅ browser-tested | Direct-to-S3 upload not wired (uploads go through the API); MinIO not run live here |
| 15 | Assets & maintenance (capitalisation, depreciation runs incl. reverse, disposal, preventive maintenance, MTBF/MTTR) | ✅ | ✅ browser-tested | No catch-up depreciation for assets in use before the first run; GST on asset sale not handled |
| 16 | Analytics (role dashboards incl. HR and employee, KPIs from ledgers, async CSV exports, forecasting) | ✅ | ✅ browser-tested | |
| 17 | Integrations: outbound webhooks (HMAC-signed, retries, SSRF guard, per-organization switch) | ✅ | ✅ browser-tested | e-invoice / e-way bill / bank-file adapters ⏳ (need GSP/bank credentials) |
| — | Multi-tenant organizations (platform operators, provisioning, suspension, per-organization flags, cross-tenant reference guard) | ✅ incl. isolation crawl | ✅ browser-tested | Logical isolation (shared database and keys); see RBAC_ABAC.md §12 and D-34 |
| — | Sign-in security (organization MFA policy, per-user MFA, self-service off, skip-for-now grace) | ✅ | ✅ browser-tested | |
| — | Mobile app (lookup, GRN, counts, transfers, POD, approvals, expenses, offline outbox) | n/a | ✅ browser build tested | Native (device) build not made; OCR receipt capture (SRS "could") not built |

## Fixed during the browser-testing pass (2026-11-01)
About 60 defects found by the specs and fixed with regression tests where they were backend-side; highlights:
- **Security/isolation:** HR, expense and finance input fields accepted another organization's ids (now scoped); the tenancy guard followed optional fields and rejected a company's own journal lines; local stacks shared Redis cache keys (flags and permission snapshots leaked between databases — cache and channel keys are now namespaced per database); SoD refusals lost their code; one wrong step-up code signed the user out.
- **Business logic:** final production receipt under-consumed materials after scrap (phantom WIP, under-costed output); a reversed payroll month never reopened; a rejected claim's reason never reached the employee; counters approving their own count got an unexplained 403; document attachments were authorized at company level instead of the record's scope (drivers couldn't attach delivery notes).
- **Usability:** money/quantity values arriving with 4–6 decimals blocked saving claims, salaries, work centres and assets; refusals now explain themselves (`self_approval`, `maker_checker`, `approval_limit`, `sod`); negative money printed as "₹-…"; quick consecutive filter changes lost the first; one-time secrets stayed in the hidden previous page; many 375 px overflows.
- **Mobile:** location lookup could hold a proof of delivery indefinitely (now 10 s), browser-build photos didn't survive reloads, missing photos failed silently.

## Fixed while building (2026-10-31)
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

## Not yet done
Docker image builds and a live MinIO/pgBackRest rehearsal (no Docker daemon here), a CI runner run with e2e, a clean restore drill, load testing and an external security test, native mobile builds, government/bank integrations (e-invoice, e-way bill, bank files), WebAuthn, Grafana dashboards, WORM export of the audit chain head, and the CSP trade-off (D-33).
