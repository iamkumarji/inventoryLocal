"""Feature flags (ARCHITECTURE §5.12). Unknown flags are disabled (deny by default)."""

from collections.abc import Iterable
from uuid import UUID

from django.core.cache import cache

from .models import FeatureFlag

_CACHE_KEY = "flags:all:v1"
_CACHE_SECONDS = 30


def _all_flags() -> dict[str, dict]:
    data = cache.get(_CACHE_KEY)
    if data is None:
        from .models import OrganizationFeatureFlag

        data = {
            f.key: {"default": f.enabled_default, "rules": f.rules or {}, "orgs": {}} for f in FeatureFlag.objects.all()
        }
        for o in OrganizationFeatureFlag.objects.all():
            if o.key in data:
                data[o.key]["orgs"][str(o.organization_id)] = {"default": o.enabled, "rules": o.rules or {}}
        cache.set(_CACHE_KEY, data, _CACHE_SECONDS)
    return data


def invalidate() -> None:
    cache.delete(_CACHE_KEY)
    cache.delete(_ORG_CACHE_KEY)


_ORG_CACHE_KEY = "flags:company-org:v1"


def _organization_of(company_id) -> str | None:
    if company_id is None:
        return None
    mapping = cache.get(_ORG_CACHE_KEY)
    if mapping is None or str(company_id) not in mapping:
        from django.apps import apps

        company_model = apps.get_model("organization", "Company")  # no import: core stays below other modules
        mapping = {str(pk): str(org) for pk, org in company_model.objects.values_list("pk", "organization_id")}
        cache.set(_ORG_CACHE_KEY, mapping, _CACHE_SECONDS)
    return mapping.get(str(company_id))


def _evaluate(flag: dict, user_id: UUID | None, role_codes: Iterable[str], company_id: UUID | None) -> bool:
    rules = flag["rules"]
    if user_id is not None and str(user_id) in rules.get("users", {}):
        return bool(rules["users"][str(user_id)])
    role_rules = rules.get("roles", {})
    matched = [bool(role_rules[c]) for c in role_codes if c in role_rules]
    if matched:
        return any(matched)
    if company_id is not None and str(company_id) in rules.get("companies", {}):
        return bool(rules["companies"][str(company_id)])
    return bool(flag["default"])


def _effective(flag: dict, organization_id) -> dict:
    """The organization's own setting when it has one, else the platform default."""
    return flag["orgs"].get(str(organization_id), flag) if organization_id is not None else flag


def is_enabled(
    key: str,
    *,
    user_id: UUID | None = None,
    role_codes: Iterable[str] = (),
    company_id: UUID | None = None,
    organization_id: UUID | None = None,
) -> bool:
    flag = _all_flags().get(key)
    if flag is None:
        return False
    org = organization_id if organization_id is not None else _organization_of(company_id)
    return _evaluate(_effective(flag, org), user_id, role_codes, company_id)


def effective_flags(
    *, user_id: UUID | None, role_codes: Iterable[str], company_id: UUID | None, organization_id: UUID | None = None
) -> dict[str, bool]:
    role_codes = list(role_codes)
    org = organization_id if organization_id is not None else _organization_of(company_id)
    return {
        key: _evaluate(_effective(flag, org), user_id, role_codes, company_id) for key, flag in _all_flags().items()
    }


def module_flag_key(module: str) -> str:
    return f"module.{module}"


# Business modules behind `module.<name>` flags. Installed switched off: an administrator enables
# each module (per company or role if wanted) once its master data and roles are set up.
MODULES = {
    "masterdata": "Items, units of measure, categories and HSN codes.",
    "partners": "Suppliers and customers.",
    "inventory": "Stock, warehouses, adjustments, transfers and counts.",
    "quality": "Inspections and non-conformances.",
    "procurement": "Requisitions, RFQs, purchase orders, receipts and MRP.",
    "manufacturing": "BOMs, routings and production orders.",
    "sales": "Quotations, sales orders, deliveries, invoices and returns.",
    "logistics": "Vehicles, drivers, shipments and proof of delivery.",
    "finance": "General ledger, payables, receivables, banking, GST and budgets.",
    "expenses": "Expense claims, advances and fuel logs.",
    "hr": "Employees, attendance, leave and payroll.",
    "assets": "Fixed assets, depreciation and maintenance.",
    "collaboration": "Tasks, comments and escalations.",
    "documents": "Document storage with versions and access control.",
    "analytics": "Dashboards, KPIs, report exports and forecasts.",
    "integrations": "Outbound webhooks to external systems.",
}


def register_module_flags() -> int:
    """Create missing module flags (disabled). Existing flags keep their administrator settings."""
    created = 0
    for module, description in MODULES.items():
        _, was_created = FeatureFlag.objects.get_or_create(
            key=module_flag_key(module), defaults={"description": description, "enabled_default": False}
        )
        created += was_created
    invalidate()
    return created
