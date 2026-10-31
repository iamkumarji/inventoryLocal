# OtabuPro ERP

Self-hosted enterprise manufacturing ERP: a modular monolith built on Django/DRF and PostgreSQL, with a Next.js web app and an Expo mobile app.

- **Design:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [SRS](docs/SRS.md) · [Database/ERD](docs/DATABASE_DESIGN.md) · [RBAC/ABAC](docs/RBAC_ABAC.md) · [API](docs/API_SPECIFICATION.md) · [Roadmap](docs/DEVELOPMENT_ROADMAP.md) · [Open decisions](docs/DECISIONS.md)
- **Progress:** [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md)

## Repository layout
```
backend/          Django project (config/) and domain modules (apps/<module>/)
frontend/         Next.js web app (typed OpenAPI client, Playwright e2e in frontend/e2e)
mobile/           Expo field app (offline outbox, scanning, POD) — see mobile/README.md
infrastructure/   Dockerfile, Compose (dev/prod), Traefik, Prometheus, Grafana
docs/             Architecture, specifications and runbooks (docs/runbooks/)
tests/            Cross-module end-to-end workflow suites (from Phase 2)
```

## Backend quick start (local PostgreSQL and Redis)
```bash
cd backend
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
createdb otabu_erp                       # or: docker compose -f ../infrastructure/docker-compose.yml up -d
.venv/bin/python manage.py migrate
# Development bootstrap (DEMO data, clearly labelled):
.venv/bin/python manage.py bootstrap_erp --org-code DEMO --org-name "DEMO Group (development data)" \
  --company-code DEMO01 --company-name "DEMO Manufacturing (development data)" \
  --admin-email admin@demo.local --admin-password 'Initial-Dev-Passw0rd!'
.venv/bin/python manage.py runserver      # API docs: http://localhost:8000/api/v1/docs/
```
On first login the admin must enrol TOTP MFA and then change the temporary password.

Background services: `celery -A config worker -l info -Q default,outbox,notifications,reports,integrations,scheduled` and `celery -A config beat`.

## Web app
```bash
cd frontend
pnpm install
pnpm dev                                  # http://localhost:3000, proxies /api to Django on :8000
```
Run Django with WebSockets through ASGI (`uvicorn config.asgi:application --port 8000`), not `runserver`, so the live notification stream works. After backend API changes, refresh the typed client:
```bash
cd backend && DJANGO_SETTINGS_MODULE=config.settings.test .venv/bin/python manage.py spectacular --validate --fail-on-warn --file ../frontend/openapi.yaml
cd ../frontend && pnpm api:types
```

### Demo data and end-to-end tests (development only)
`seed_demo` creates DEMO-labelled branches, warehouses, three approvers/requesters and a DEMO approval route, and submits requests through the real services. It refuses to run unless `DEBUG` and `ERP_DEMO_DATA` are on.
```bash
cd backend
dropdb otabu_erp; createdb otabu_erp; .venv/bin/python manage.py migrate
.venv/bin/python manage.py bootstrap_erp ...            # as above
.venv/bin/python manage.py seed_demo
THROTTLE_AUTH=1000/min .venv/bin/uvicorn config.asgi:application --port 8000   # e2e signs in many times
.venv/bin/celery -A config worker -Q default,outbox,notifications,reports,integrations,scheduled --pool=solo
.venv/bin/celery -A config beat
cd ../frontend && pnpm dev & pnpm exec playwright test
```
The e2e suite enrols the admin's MFA on first sign-in, so it expects a freshly seeded database.

## Quality gates
```bash
cd backend
.venv/bin/pytest --cov=apps          # real PostgreSQL; triggers and constraints are part of the design
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/lint-imports               # module layering contracts
cd ../frontend && pnpm lint && pnpm typecheck && pnpm build
```

### Per-module browser specs (development only)
Each module area has its own Playwright spec (`frontend/e2e/20-inventory`, `30-trade`, `40-finance`, `50-production`, `60-people`). Run each against a freshly seeded database together with `01-admin-first-login` (which enrols the admin's MFA once per database), for example:
```bash
E2E_BASE_URL=http://localhost:3000 pnpm exec playwright test e2e/01-admin-first-login.spec.ts e2e/40-finance.spec.ts
```
Business modules start switched off: enable them in Admin › Feature flags (the specs do this through the API). Coverage achieved so far is listed in `DEVELOPMENT_STATUS.md`.

## Operations
```bash
python manage.py verify_integrity      # audit chain, balanced journals, sub-ledgers = GL, stock = ledger, keys readable
python manage.py rotate_field_keys     # after putting a new key first in FIELD_ENCRYPTION_KEYS
infrastructure/backup/backup.sh        # nightly dump + documents mirror
infrastructure/backup/restore-drill.sh <backup dir>   # restore into a scratch DB and verify
```
Procedures: [docs/runbooks](docs/runbooks/README.md).

## Production
See `infrastructure/docker-compose.prod.yml`, `infrastructure/.env.example` and [the deployment runbook](docs/runbooks/deployment.md). Production settings refuse to start without `DJANGO_SECRET_KEY` and `FIELD_ENCRYPTION_KEYS`. All business modules are installed switched off. Do not route `/metrics` publicly.
