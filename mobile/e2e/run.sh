#!/usr/bin/env bash
# Mobile end-to-end run on a fresh DEMO database (development only).
#   mobile/e2e/run.sh            # from the repository root or anywhere
# Uses: Postgres DB otabu_erp_mobile, API :8170, web build + proxy :8190, Redis DB 10.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mobile="$(dirname "$here")"
backend="$(dirname "$mobile")/backend"
logs="${E2E_LOGS:-$mobile/test-results/logs}"
mkdir -p "$logs"

export DATABASE_URL=postgres:///otabu_erp_mobile DJANGO_SETTINGS_MODULE=config.settings.dev ERP_DEMO_DATA=1
export CELERY_BROKER_URL=redis://localhost:6379/10 THROTTLE_AUTH=1000/min

cleanup() { kill $(jobs -p) 2>/dev/null || true; }
trap cleanup EXIT

cd "$backend"
dropdb --if-exists --force otabu_erp_mobile
createdb otabu_erp_mobile
.venv/bin/python manage.py migrate -v0
.venv/bin/python manage.py bootstrap_erp --org-code DEMO --org-name "DEMO Group (development data)" \
  --company-code DEMO01 --company-name "DEMO Manufacturing (development data)" \
  --admin-email admin@demo.local --admin-password 'Initial-Dev-Passw0rd!' >/dev/null
.venv/bin/python manage.py seed_demo >/dev/null
.venv/bin/python manage.py shell < "$here/setup_backend.py"

.venv/bin/uvicorn config.asgi:application --port 8170 >"$logs/api.log" 2>&1 &
.venv/bin/celery -A config worker -Q default,outbox,notifications,reports,integrations,scheduled --pool=solo -l warning >"$logs/celery.log" 2>&1 &

cd "$mobile"
[ -d dist ] || npx expo export --platform web
node e2e/serve.mjs dist >"$logs/web.log" 2>&1 &
for _ in $(seq 1 40); do curl -sf -o /dev/null http://localhost:8190/login && curl -s -o /dev/null http://127.0.0.1:8170/health/live && break; sleep 0.5; done
npx playwright test "$@"
