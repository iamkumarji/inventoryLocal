# OtabuPro ERP — Development Roadmap

Each phase ends with exit criteria that must be verified by automated tests before the next phase starts. Progress is tracked in [DEVELOPMENT_STATUS.md](../DEVELOPMENT_STATUS.md). Durations assume a team of 4–6 engineers; they're planning estimates, not commitments.

| Phase | Name | Scope | Exit criteria |
|---|---|---|---|
| **0** | Blueprint | Architecture, SRS, ERD, RBAC/ABAC, API spec, roadmap, decision register | Documents reviewed; open decisions listed with assumptions |
| **1** | Platform foundation | Monorepo, settings, core (UUIDv7, base models, money/qty types, errors, pagination, request ID, idempotency, outbox, numbering, feature flags), organization scope, identity (login, sessions, MFA, lockout), authorization (RBAC, ABAC, PDP, SoD, approval limits, scope filtering), audit (append-only, hash chain), OpenAPI, Celery and Channels wiring, CI tooling, Docker baseline | All foundation tests green against PostgreSQL; default deny proven; audit immutability proven by trigger test; OpenAPI schema generates without errors |
| **1b** | Web shell + approvals engine | Next.js app shell (login, MFA, sidebar from permissions, breadcrumbs, scope switcher, ⌘K), admin screens (users, roles, assignments, policies, flags, audit viewer); generic `approvals` and `notifications` modules | Login → MFA → permission-driven navigation works end to end; approval request lifecycle tested with SoD/limit guards |
| **2** | Master data + inventory | Items, UoM, categories, HSN, barcodes, partners; locations, stock ledger, balances, batches, serials, reservations, transfers, adjustments, counts, valuation, ageing; scan API | Concurrency test (parallel issues cannot oversell); ledger ↔ balance rebuild test; negative-stock guard; reversal tests |
| **3** | Procurement + quality | MRP (suggestions), PR, RFQ, quotations, comparison, PO, GRN, inspection, purchase returns | P2P up to GRN/inspection scenario green (finance postings stubbed behind interface until Phase 5, flagged) |
| **4** | Manufacturing | Work centres, BOM + versions + explosion, routings, plans, production orders, reservation, issue/backflush, confirmation, output, scrap, rework, costing | Plan-to-Produce scenario green with ledger assertions |
| **5** | Finance + sales + logistics | CoA, posting profiles, GL engine, AP/AR, payments, bank reconciliation, GST, budgets, cost centres, statements; retrofit postings for inventory/procurement/manufacturing; sales quotations → invoices, returns, receipts; logistics shipments, vehicles, drivers, POD | P2P, Plan-to-Produce and O2C scenarios green **including GL**; trial balance balances; sub-ledger ↔ GL reconciliation zero difference |
| **6** | Expenses + HR + payroll | Expense claims, fuel logs, advances; employees, attendance, leave, payroll with salary access restrictions | Expense-to-Payment green; salary field-level security tests |
| **7** | Collaboration + documents + assets | Tasks, comments, mentions, escalation; DMS with versioning/ACL on MinIO; assets, depreciation, maintenance | Escalation and ACL inheritance tests |
| **8** | Analytics + experiences | Role dashboards, reports engine (async), KPIs, forecasting; polished per-experience UIs | Dashboard data matches ledger-based reconciliation queries |
| **9** | Mobile | Expo app: scanning (GRN, putaway, pick, transfer, count, issue, output), POD, expenses, approvals; offline queue | Device E2E for scanning flows; idempotent replay tests |
| **10** | Production hardening | Docker production stack, Traefik TLS, Prometheus/Grafana/alerts, Sentry, pgBackRest + restore drill, load tests, security tests (ZAP, authz matrix), runbooks, UAT, data migration tooling | Restore drill within RTO; load test meets NFR-001; zero high findings |

## Cross-phase rules
- A module ships behind a feature flag until its exit criteria pass.
- Finance postings that precede Phase 5 are written through `finance.services` interfaces that, until Phase 5, record **pending accounting events** (not lost, posted retroactively by a migration job when the GL engine is enabled). This is flagged and listed as a known limitation.
- Every phase updates `DEVELOPMENT_STATUS.md`, the OpenAPI schema and the relevant design document.

## Phase 1 detailed plan
| Step | Deliverable | Files |
|---|---|---|
| 1.1 | Backend project, settings split (base/dev/test/prod), env config, logging, health endpoints | `backend/config/*`, `backend/pyproject.toml` |
| 1.2 | `core`: UUIDv7, base models, decimal fields, exceptions and handler, pagination, request context middleware, idempotency, outbox + relay, document sequences, feature flags, immutability trigger helper | `backend/apps/core/*` |
| 1.3 | `organization`: models, services, selectors, API, fiscal calendar | `backend/apps/organization/*` |
| 1.4 | `identity`: custom user, Argon2, sessions + auth class, CSRF, login/MFA/logout/me/sessions, lockout, password policy | `backend/apps/identity/*` |
| 1.5 | `authorization`: models, permission registry, PDP, condition evaluator, scope filter, DRF permission class, SoD, approval limits, admin APIs, seed command | `backend/apps/authorization/*` |
| 1.6 | `audit`: model, trigger migration, hash chain, recorder service, query API, verify job | `backend/apps/audit/*` |
| 1.7 | OpenAPI, Celery app, Channels ASGI, Docker baseline, Makefile, CI config | `backend/config/celery.py`, `asgi.py`, `infrastructure/*` |
| 1.8 | Tests: unit + integration on PostgreSQL | `backend/apps/*/tests/` |
