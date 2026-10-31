# Deployment and upgrades

**Who:** platform engineer, with a second person on call. **When:** each release, in the agreed window.

## First installation (not yet rehearsed on target VMs)
1. Copy `infrastructure/.env.example` to `infrastructure/.env` and fill every value. Generate secrets:
   - `DJANGO_SECRET_KEY`: `python -c "import secrets; print(secrets.token_urlsafe(64))"`
   - `FIELD_ENCRYPTION_KEYS`: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
   Store both in the password vault. **Losing the encryption key makes MFA seeds, bank and PAN data unreadable.**
2. Put the TLS certificate and key at `infrastructure/traefik/certs/erp.crt|erp.key`; set the hostnames in `traefik/dynamic.yml` (app and `files.` host).
3. `docker compose -f infrastructure/docker-compose.prod.yml up -d --build`. `minio-init` creates the documents bucket; `migrate` applies migrations before `api` starts.
4. Bootstrap once:
   `docker compose -f infrastructure/docker-compose.prod.yml run --rm api python manage.py bootstrap_erp --org-code … --company-code … --admin-email … --admin-password '<temporary>'`
5. Sign in as the admin: enrol MFA, change the password. Then in **Feature flags** switch on modules one at a time as their master data and roles are ready (all start off).
6. Run `python manage.py verify_integrity` — every line must be `OK`.

## Upgrade
1. Read the release notes for migrations that lock large tables; schedule accordingly.
2. Take a backup (`infrastructure/backup/backup.sh`) and confirm it finished.
3. `ERP_VERSION=<tag> docker compose -f infrastructure/docker-compose.prod.yml up -d --build`. The `migrate` job runs first; `api` replicas restart after it succeeds.
4. Check: `/health/ready` is 200; sign in; open Approvals; `verify_integrity` passes; no new errors in Sentry.
5. Roll back: redeploy the previous tag. Migrations are forward-only; if one must be undone, restore the pre-upgrade backup (see backup-restore) — never edit posted ledger tables by hand (they are protected by triggers).

## Mobile app
Native builds are made with EAS (`cd mobile && npx eas-cli@latest build`), with `EXPO_PUBLIC_API_URL` set to the public HTTPS address. Devices sign in with the same accounts; users whose role requires MFA must enrol on the web first.
