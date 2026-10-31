#!/usr/bin/env bash
# Nightly logical backup: PostgreSQL (custom format, checksummed) + MinIO documents mirror.
# Continuous WAL archiving (pgBackRest) is the primary PITR mechanism on the DB VM; this dump is the
# independent second copy that the restore drill uses. Run from cron on the backup host.
#
# Env: DATABASE_URL, BACKUP_DIR, [MINIO_ALIAS (mc alias), DOCUMENTS_BUCKET], [RETENTION_DAYS=14]
set -euo pipefail
: "${DATABASE_URL:?}" "${BACKUP_DIR:?}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$BACKUP_DIR/$stamp"
mkdir -p "$dest"
umask 077

pg_dump --format=custom --compress=6 --no-owner --file "$dest/erp.dump" "$DATABASE_URL"
pg_restore --list "$dest/erp.dump" > /dev/null    # the archive is readable
( cd "$dest" && sha256sum erp.dump > SHA256SUMS 2>/dev/null || shasum -a 256 erp.dump > SHA256SUMS )

if [[ -n "${MINIO_ALIAS:-}" && -n "${DOCUMENTS_BUCKET:-}" ]]; then
  # Object versioning on the bucket keeps overwritten/deleted versions; this mirror is the off-box copy.
  mc mirror --overwrite --preserve "$MINIO_ALIAS/$DOCUMENTS_BUCKET" "$BACKUP_DIR/documents-mirror" > "$dest/documents-mirror.log"
fi

find "$BACKUP_DIR" -maxdepth 1 -type d -name '20*T*Z' -mtime "+${RETENTION_DAYS:-14}" -exec rm -rf {} +
echo "backup ok: $dest"
