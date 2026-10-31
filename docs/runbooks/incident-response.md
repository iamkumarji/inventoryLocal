# Incident response

| Severity | Examples | Response |
|---|---|---|
| P1 | Data breach suspected, ledger integrity failure, platform down | Page on-call + security lead now; update stakeholders hourly |
| P2 | Failed restore drill, outbox dead letters growing, one module down | Same working day |
| P3 | Single-user problem, slow report | Next working day |

## First 30 minutes
1. Confirm and timestamp. Open an incident note (what, when, who noticed).
2. Contain:
   - Compromised account → Admin › Users › **Lock** and **End all sessions**; reset MFA; review its audit trail (Admin › Audit log, filter by actor).
   - Leaked API/session token → end that session; if widespread, rotate `DJANGO_SECRET_KEY` (signs everyone out).
   - Suspected tampering → run `python manage.py verify_integrity`; `audit_chain` names the first broken sequence number.
   - Runaway module → switch its feature flag off (Admin › Feature flags) — the API then refuses its endpoints.
3. Preserve evidence: export the audit log for the window; keep application and Traefik logs; do not restore over the affected database (restore into a separate one for comparison).

## Afterwards
Root cause, what detected it, what would have detected it sooner, follow-up actions with owners. Personal-data breaches: legal/DPO decides on notifications under applicable law.
