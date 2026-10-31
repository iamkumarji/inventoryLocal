# Backup and restore

**Targets:** RPO ≤ 15 minutes (WAL archiving), RTO ≤ 4 hours. **Owner:** platform engineer.

## What is backed up
| Data | How | Where |
|---|---|---|
| PostgreSQL | pgBackRest full weekly + differential daily + continuous WAL archive (primary, point-in-time); **plus** a nightly logical dump by `infrastructure/backup/backup.sh` (independent second copy) | Backup host, then off-site |
| Documents (MinIO) | Bucket versioning (overwrites/deletes recoverable) + nightly `mc mirror` in `backup.sh` | Backup host, then off-site |
| Secrets (`.env`, encryption keys, TLS) | Password vault, never in backups of the app host | Vault |
| Audit chain head | Exported with each dump (in the database); external WORM export is a pending item | — |

pgBackRest configuration lives with the database VM build (see ARCHITECTURE §3); **it has not been rehearsed yet** — until it is, the nightly dump is the restore path that has been tested.

## Nightly
`DATABASE_URL=… BACKUP_DIR=/srv/erp-backups MINIO_ALIAS=erp DOCUMENTS_BUCKET=erp-documents infrastructure/backup/backup.sh`
The script writes `erp.dump` plus `SHA256SUMS`, verifies the archive is readable, mirrors documents and prunes copies older than `RETENTION_DAYS`. Alert if it exits non-zero or if no new folder appears by 03:00.

## Monthly restore drill (and after any change to backup tooling)
```
FIELD_ENCRYPTION_KEYS=… DJANGO_SECRET_KEY=… infrastructure/backup/restore-drill.sh /srv/erp-backups/<stamp>
```
It checks the checksum, restores into a **scratch** database (`otabu_erp_restore_drill`), checks the schema is current and runs `verify_integrity`: audit hash chain, every journal balanced, stock/AR/AP sub-ledgers equal the GL, stock valuation equals the stock ledger, every encrypted value decrypts. Record the restore time and result in the ops log. A failed drill is a P2 incident.

## Disaster recovery (production restore)
1. Declare the incident; stop `api`, `worker`, `beat` so nothing writes.
2. Point-in-time restore with pgBackRest to just before the fault (or restore the latest nightly dump if WAL is unavailable — data after that dump is lost and must be re-entered from source documents).
3. Restore documents from the mirror (or roll back object versions in MinIO).
4. Run `python manage.py verify_integrity`. Do not reopen to users until it passes.
5. Start services; tell users the recovery point; re-enter transactions after it from paper/e-mail trails. Posted entries are never edited — corrections are reversals.
