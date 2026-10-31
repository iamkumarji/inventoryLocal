# Runbooks

Operational procedures for OtabuPro ERP. Each runbook says who does it, how often, and how to tell it worked.

| Runbook | When |
|---|---|
| [Deployment and upgrades](deployment.md) | Every release |
| [Backup and restore](backup-restore.md) | Nightly backups; monthly restore drill; disaster recovery |
| [Encryption key rotation](key-rotation.md) | Yearly, or at once if a key may have leaked |
| [Incident response](incident-response.md) | Security or availability incidents |
| [Month-end and year-end close](period-close.md) | Monthly / yearly (finance) |
| [People joining, moving and leaving](access-lifecycle.md) | HR events |

Status of verification is tracked in `DEVELOPMENT_STATUS.md`. Steps marked **(not yet rehearsed)** have been written but not run end to end on production-like infrastructure.
