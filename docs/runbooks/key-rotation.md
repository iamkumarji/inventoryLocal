# Encryption key rotation

Field-level secrets (MFA seeds, partner bank accounts, employee PAN/bank/Aadhaar-last-4) are encrypted with the keys in `FIELD_ENCRYPTION_KEYS` (comma-separated; the first encrypts, all decrypt). The list of encrypted columns is `ENCRYPTED_COLUMNS` in `backend/apps/core/crypto.py`.

**When:** yearly, when someone with key access leaves, or immediately if a key may be exposed.

1. Generate a new key and store it in the vault.
2. Set `FIELD_ENCRYPTION_KEYS=<new>,<old>` and redeploy (both keys readable, new key encrypts).
3. `python manage.py rotate_field_keys --dry-run` (counts), then `python manage.py rotate_field_keys`. It re-encrypts every value under the new key and writes an audit event.
4. On a restored copy (or staging) set only `<new>` and run `python manage.py verify_integrity`: `encrypted_values_readable` must be OK.
5. Set `FIELD_ENCRYPTION_KEYS=<new>` in production, redeploy, run `verify_integrity` again. Destroy the old key after the backup retention period (older backups still need it — keep it in the vault until those expire).

`DJANGO_SECRET_KEY` rotation signs everyone out and invalidates document links and lookup hashes for recovery codes; plan it with users, and have them regenerate recovery codes afterwards.
