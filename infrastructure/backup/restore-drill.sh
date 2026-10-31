#!/usr/bin/env bash
# Restore drill: restore a backup into a scratch database and prove the books are intact.
# Never restores over the live database. Exit code is non-zero if anything fails.
#
#   restore-drill.sh <backup dir>          e.g. /backups/20261031T010000Z
# Env: DRILL_DATABASE (default otabu_erp_restore_drill), BACKEND_DIR (default ../../backend),
#      plus the production FIELD_ENCRYPTION_KEYS / DJANGO_SECRET_KEY so encrypted values can be read.
set -euo pipefail
src="${1:?backup directory}"
db="${DRILL_DATABASE:-otabu_erp_restore_drill}"
backend="${BACKEND_DIR:-$(cd "$(dirname "$0")/../../backend" && pwd)}"

( cd "$src" && (sha256sum -c SHA256SUMS 2>/dev/null || shasum -a 256 -c SHA256SUMS) )
dropdb --if-exists --force "$db"
createdb "$db"
started=$(date +%s)
pg_restore --no-owner --exit-on-error --dbname "$db" "$src/erp.dump"
echo "restored in $(( $(date +%s) - started ))s"

cd "$backend"
export DATABASE_URL="postgres:///$db"
.venv/bin/python manage.py migrate --check          # schema is at the deployed version
.venv/bin/python manage.py verify_integrity          # audit chain, ledgers, stock, encrypted data
echo "restore drill passed for $src"
