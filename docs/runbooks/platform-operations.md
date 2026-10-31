# Platform operations (multi-tenant)

**Who:** platform operators (accounts with `is_platform_operator`; they belong to no organization).

## Create the first operator (once per installation)
`python manage.py create_platform_operator --email ops@yourcompany.com --password '<temporary>'`
They must enrol MFA and set a new password at first sign-in. Keep at least two operators.

## Onboard a customer organization
Web app → **Platform** → *Create organization*: organization code and name, first company (legal name, state, GSTIN), first administrator (email, name; a temporary password is generated — send it by a separate channel).
This creates the organization, the company with its fiscal year and template chart of accounts, role/policy templates, and the administrator with forced MFA and password change. From there the customer's administrator runs everything inside it (companies, users, roles, module switches). Operators can't see customer data.

## Suspend / reactivate
Platform → the organization → *Suspend* with a reason: every user is signed out and can't sign in; data, scheduled jobs and webhooks are untouched. Reactivate the same way. Both are audited.

## Physical isolation
Customers that require a separate database, keys or region get their own installation (`docs/runbooks/deployment.md`) — the multi-tenant installation isolates logically, not physically.
