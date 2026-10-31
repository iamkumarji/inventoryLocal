# OtabuPro ERP — Authorization Design (RBAC + ABAC)

Status: **Baseline v1.0**, implemented in Phase 1 (`backend/apps/authorization`).

## 1. Principles
1. **Default deny.** Access is granted only if an explicit grant exists and no deny applies.
2. **One decision point.** All checks — API views, querysets, services, WebSocket subscriptions, file downloads, exports, Celery tasks acting for users — call `authorization.pdp`.
3. **Server-side only.** The frontend receives *effective permissions* to render navigation, but it is never trusted.
4. **Least privilege and scope isolation.** Grants are bound to an organizational scope; data outside the scope is invisible (filtered), not just forbidden.
5. **Separation of duties by default.** Makers cannot check their own work; nobody approves their own financial transaction unless an explicit, audited, MFA-protected exception exists.
6. **Everything is configuration.** Roles, permissions-to-role mapping, policies, approval limits and SoD rules are data, seeded from labelled templates and changed through audited admin APIs.

## 2. Permission model (RBAC)

### 2.1 Permission codes
`<module>.<resource>.<action>`, e.g. `inventory.stock_adjustment.approve`, `finance.journal_entry.post`, `hr.salary.read`.

| Action | Meaning |
|---|---|
| `create` | Create a draft record |
| `read` | View records (list and detail) |
| `update` | Change a record while it is editable (draft or rejected) |
| `delete` | Delete a draft or deactivate master data; never posted data |
| `approve` | Approve in a workflow step (subject to limits and SoD) |
| `reject` | Reject or return in a workflow step |
| `post` | Commit to ledgers (stock or GL) |
| `cancel` | Cancel or reverse a posted document (creates a reversal) |
| `export` | Bulk export (CSV/XLSX/PDF reports) |
| `download` | Download attachments and generated files |
| `assign` | Assign records, tasks or roles to others |
| `manage` | Administer configuration of that resource type (settings, series, templates) |

There are **no implied actions** (for example, `manage` does not imply `approve`). Each permission row has `is_sensitive` (audited on use) and `requires_mfa` (step-up required).

### 2.2 Roles and scoped assignments
- `roles` are bundles of permissions. Seeded **templates** (§7) can be cloned and edited; template rows themselves are read-only.
- `role_assignments(user, role, scope_type, scope_id, include_descendants, valid_from, valid_until)`.
- Scope hierarchy: `organization ⊃ company ⊃ branch ⊃ facility ⊃ warehouse`, and `company ⊃ department (tree)`.
  - A **warehouse-scoped** storekeeper sees and moves stock only in that warehouse.
  - A **department-scoped** manager approves expenses of employees in that department subtree.
- `include_descendants = false` makes a grant match only records attributed to that exact node — records whose finer hierarchy levels (branch → facility → warehouse) are empty. Example: a facility grant without descendants covers facility-level records but not the warehouses inside it. Applied identically to object checks and SQL row filters.
  - A **company-scoped** accountant sees that company's ledgers only.
- Resources expose their scope attributes (`company_id`, `branch_id`, `facility_id`, `warehouse_id`, `department_id`). A grant matches a resource if the resource's attribute for the assignment's scope type is in the assignment's (expanded) scope set. Resources without a lower-level attribute (e.g. a company-level journal) only match company-or-higher assignments.

## 3. ABAC

### 3.1 Attributes
| Category | Attributes (examples) |
|---|---|
| Subject | `subject.id`, `subject.is_active`, `subject.role_codes`, `subject.department_ids`, `subject.employee_id`, `subject.mfa_verified`, `subject.session_client_type` |
| Resource | `resource.type`, `resource.id`, `resource.company_id`, `resource.branch_id`, `resource.warehouse_id`, `resource.department_id`, `resource.status`, `resource.amount`, `resource.currency`, `resource.created_by_id`, `resource.submitted_by_id`, `resource.owner_id`, `resource.employee_id`, `resource.is_sensitive` |
| Action | `action.code`, `action.verb` |
| Environment | `env.now`, `env.time` (`HH:MM`, company timezone), `env.weekday` (1–7), `env.ip`, `env.ip_internal`, `env.client_type`, `env.approval_limit` (computed), `env.period_open` |

Resource attributes come from a per-resource-type **attribute provider** registered by the owning module (`policies.py`), so the PDP never queries module tables directly.

### 3.2 Policy language (stored in `abac_policies.condition`)
```json
{
  "all": [
    {"attr": "resource.amount", "op": "gt", "value": 100000},
    {"attr": "env.ip_internal", "op": "eq", "value": false}
  ]
}
```
Grammar:
- Combinators: `{"all": [...]}`, `{"any": [...]}`, `{"not": {...}}`.
- Comparison: `{"attr": "<ref>", "op": "<op>", "value": <literal | {"attr": "<ref>"}>}`.
- Operators: `eq, ne, lt, lte, gt, gte, in, not_in, contains, exists, starts_with, time_between` (`value: ["09:00","19:00"]`).
- Missing attributes evaluate as `null`; any comparison against `null` except `exists`/`eq null` is **false**. For `deny` policies, a condition that errors is treated as **matched** (fail closed).
- Decimal-safe comparisons (amounts are compared as `Decimal`).

A policy row has: `effect` (`allow`|`deny`), `actions` (permission codes, wildcards allowed: `finance.*.approve`, `*.*.export`), `resource_types`, `condition`, `priority`, `is_active`.

### 3.3 Example policies (seeded as templates, inactive unless noted)
| Code | Effect | Targets | Condition | Purpose |
|---|---|---|---|---|
| `deny_export_outside_network` | deny | `*.*.export`, `*.*.download` | `env.ip_internal == false` | Block bulk export from outside the LAN/VPN |
| `deny_payroll_outside_hours` | deny | `hr.payroll_run.*` | `not time_between 08:00–20:00` | Time window |
| `allow_own_payslip` (active) | allow | `hr.payslip.read`, `hr.payslip.download` | `resource.employee_id == subject.employee_id` | Self-service without a role grant |
| `allow_own_expense` (active) | allow | `expenses.expense_claim.read/update` | `resource.created_by_id == subject.id` | Owner access |
| `deny_mobile_journal_post` | deny | `finance.journal_entry.post` | `env.client_type == "mobile"` | Channel restriction |

## 4. Decision algorithm

```
authorize(subject, action, resource=None, env) -> Decision
 1. subject inactive / locked / session invalid      -> DENY (inactive_subject)
 2. permission code unknown                         -> DENY (unknown_permission)
 3. module feature flag disabled                    -> DENY (feature_disabled)
 4. rbac = scoped role grants for action matching resource scope
 5. abac_allow = any active allow-policy targeting action/resource_type whose condition is true
 6. if not rbac and not abac_allow                  -> DENY (no_grant)          # default deny
 7. if any active deny-policy matches               -> DENY (policy:<code>)     # deny overrides
 8. built-in guards (cannot be disabled by policy rows):
    a. permission.requires_mfa and not subject.mfa_verified -> DENY (mfa_required)
    b. action verb in {approve, reject, post} and subject is resource.created_by/submitted_by
       and subject lacks explicit grant of `<module>.<resource>.self_approve`  -> DENY (self_approval)
    c. verb == approve and resource.amount present:
         limit = max approval_limit over subject's roles granting the action
                 for (document_type, currency, company)
         limit missing or amount > limit                  -> DENY (approval_limit)
    d. SoD rules: same_user_same_record conflicts recorded in workflow history -> DENY (sod:<code>)
 9. ALLOW with obligations (e.g. mask fields, audit_access=true for sensitive)
```

- **List operations** call `pdp.scope_filter(subject, action, resource_type)`, which returns the union of permitted scopes (plus owner-based allow conditions that can be expressed as filters). Selectors apply it as a `Q` object. An empty set returns `queryset.none()`.
- **Deny reasons** are returned to the client only as a generic `permission_denied` code (plus `mfa_required` so the UI can trigger step-up). Detailed reasons go to logs and, for sensitive resources, to audit.

## 5. Separation of duties and maker-checker
- `sod_rules` declare conflicting permission pairs:
  - `same_user_same_record`: the user who performed A on a record cannot perform B on the same record (e.g. `procurement.purchase_order.create` vs `procurement.purchase_order.approve`, `finance.payment.create` vs `finance.payment.approve`, `inventory.stock_count.count` vs `inventory.stock_count.approve`).
  - `same_user_any`: a user cannot hold both permissions at all (checked at role-assignment time and reported in the SoD conflict report; e.g. `finance.vendor_bank.update` vs `finance.payment.approve`).
- Workflow history (`approval_steps`) records who did what, which feeds rule evaluation.
- Self-approval is blocked by a built-in guard (§4 step 8b) independent of configuration. Only an explicit, sensitive, MFA-protected `*.self_approve` grant can override it, and its use is audited.

## 6. Approval limits and matrix
Implemented in Phase 1b (`backend/apps/approvals`).
- `approval_limits(role, document_type, company?, currency, max_amount)`: no hardcoded thresholds. **The limit is enforced at the final step of a route**; intermediate steps endorse (D-31). A role without a limit row cannot give final approval for amount-bearing documents.
- One person can decide at most one step of a request, and never their own request (also not as a delegate).
- `approvals` module (Phase 1b) defines approval **matrices**: ordered levels by amount band, department, category or cost centre, each resolved to role and scope. A document needs every required level; a level can be satisfied only by a user who passes the PDP for `approve` (limit, SoD, scope).
- Escalation: unacted approvals escalate after a configurable SLA to the next level or a delegate; **delegation** (`approval_delegations`, time-boxed) never lets a delegate approve their own document.

Template boundaries, enforced by `test_template_patterns_never_grant_business_postings_to_sysadmin`: the System Administrator template holds no approve or post permission, can't manage approval routes or approval limits, and can't manage or verify the audit trail. Routes and limits belong to the Finance Controller template, which separates IT administration from financial control.

## 7. Seeded role templates (configurable, labelled `template`)
| Role | Typical scope | Highlights |
|---|---|---|
| Break-glass Super Admin | organization | Emergency only, MFA required, every action audited and alerted; not for daily use |
| System Administrator | organization | Users, roles, policies, flags, integrations; **no** financial posting or approval |
| Management / Director | company | Read all dashboards and reports, approve high-value documents within limits |
| Finance Controller | company | GL, period close, approve payments and journals within limits, manage posting profiles |
| Accountant | company | Create and post journals, AP/AR processing, bank reconciliation |
| AP Clerk / AR Clerk | company/branch | Invoices and receipts entry, no approval |
| Procurement Manager | company/branch | Approve PR/PO within limits, supplier management |
| Buyer | branch | RFQ, quotations, PO drafts |
| Warehouse Manager | facility/warehouse | Approve adjustments and counts, transfers |
| Store Keeper | warehouse | GRN receive, putaway, issue, pick, count |
| Production Planner | facility | Plans, MRP, production orders |
| Production Supervisor | facility | Release and close orders, confirm output, scrap |
| Shop Floor Operator | facility | Material issue and output confirmation via mobile |
| Quality Inspector | facility | Inspections, NCR |
| Sales Manager / Sales Executive | branch | Quotations, orders (credit override only for manager) |
| Logistics Coordinator / Driver | branch | Shipments, trips / own trips and POD only |
| HR Manager / Payroll Officer | company | Employees, leave / payroll (salary data, MFA required) |
| Maintenance Technician | facility | Work orders, spare consumption |
| Employee (self-service) | own department | Own profile, attendance, leave, expenses, payslips, tasks |
| Internal Auditor | company | Read-only on all modules and audit trail, export with justification |

## 8. Authentication, MFA and sessions
- Argon2id password hashing; minimum 12 characters; reuse of last 5 blocked; breached-list check; configurable expiry (off by default per NIST 800-63B).
- Lockout after 5 failed attempts for 15 minutes (configurable), plus Traefik/DRF rate limits.
- MFA: TOTP enrolment (QR + manual key), confirmation with a valid code, 10 single-use recovery codes, replay prevention (`last_used_step`). MFA can be **enforced** per user or per role; permissions marked `requires_mfa` require an MFA-verified session (step-up within the last N minutes, default 15).
- Sessions: opaque random token, hashed at rest; idle timeout and absolute lifetime; list and revoke own sessions; admins can revoke any; all sessions revoked on password change, MFA reset, deactivation or role removal of sensitive roles.

## 9. Field-level and data protection
- Serializers declare `sensitive_fields` with a required permission (e.g. `salary_amount → hr.salary.read`); without it, the field is omitted (not nulled) and the omission is consistent in list, detail and export.
- Exports and downloads require explicit `export`/`download` permissions and are audited with filter criteria and row counts.

## 10. Audit
Audited: login success/failure, MFA events, session revocation, permission/role/policy/assignment changes, denied access to sensitive resources, all postings, approvals and rejections, exports and downloads, configuration changes, break-glass use. `audit_events` is append-only (DB trigger) and hash-chained; a scheduled job verifies the chain and alerts on breaks.

## 11. Testing obligations
- PDP unit tests for each step of the algorithm (default deny, scope matching, descendant expansion, validity windows, deny-overrides, MFA, self-approval, approval limits, SoD).
- **Authorization matrix test**: every registered API endpoint is called as an unauthenticated user, a user with no roles and a user scoped to another company, and must return 401/403/404 accordingly.

## 12. Multi-tenancy (organizations)

One installation can host several **organizations** (tenants: unrelated businesses). Isolation holds at every layer:

| Layer | Rule |
|---|---|
| Accounts | Every user belongs to exactly one organization (platform operators to none). Sign-in and existing sessions are refused while the organization is suspended. |
| Grants | Role assignments, roles, policies, SoD rules, approval limits and routes belong to an organization; a grant's scope never reaches another organization, so lists and record views can't show another tenant's data. |
| Company context | `X-Company-ID` is accepted only for companies the user has grants in; anything else falls back to the user's own companies. |
| References in input | Every API related field resolves ids only inside the caller's organization (`apps/authorization/tenancy.py`, installed for all serializers): naming another tenant's item, supplier or account is a validation error, not a lookup. |
| Shared master data | Items, partners, units are shared only *within* an organization (scope `shared` = the grant's organization). |
| Feature flags | The platform sets defaults; each organization's switches and targeting are stored per organization (`OrganizationFeatureFlag`) and may only target its own users and companies. |
| Operational views | The outbox view shows only events of the organization's companies; the audit log is bounded by grants. |
| Platform operators | `is_platform_operator` users create (`POST /platform/organizations/`) and suspend organizations, with recent MFA. They hold no grants in any organization and see only directory figures (code, name, status, user and company counts) — never business data. |

Proof: `backend/apps/platform/tests/test_tenant_isolation.py` provisions two tenants, crawls every list endpoint as one tenant's administrator (with every read permission) asserting none of the other tenant's ids appear, opens the other tenant's records by id (404), references them in a create (400), forges the company header, switches a module (other tenant unaffected), suspends a tenant, and checks the operator console is operator-only.

Limits: tenants share one database and one set of encryption keys (logical isolation). Customers that need physical separation get their own installation (see `docs/runbooks/platform-operations.md`).

## 13. Two-step sign-in policy (per organization)

Administrators set it under **Admin → Sign-in security** (`/api/v1/organization/security/`, permission `organization.organization.update`):

| Setting | Default | Effect |
|---|---|---|
| Two-step sign-in for everyone | off | On: every user must enrol an authenticator; users without one are restricted to enrolment at next sign-in. |
| Fresh code before sensitive actions | on | On: permissions marked MFA in the catalogue need a code verified in the last `ERP_STEP_UP_MINUTES`. Off: they don't (approval limits, maker-checker, SoD and audit still apply). |

MFA is also required per user (`mfa_enforced`, set by an admin on the user's page) and per role (`mfa_required`). Users may turn their own two-step sign-in off (password + current code) only when none of these rules applies. Relaxing the policy needs a recently verified administrator when they use MFA themselves, and every change is audited. Platform operators and break-glass superusers always need MFA; the explicit self-approval exception and recovery-code regeneration always need a fresh code.
