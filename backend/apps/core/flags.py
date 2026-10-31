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
        data = {f.key: {"default": f.enabled_default, "rules": f.rules or {}} for f in FeatureFlag.objects.all()}
        cache.set(_CACHE_KEY, data, _CACHE_SECONDS)
    return data


def invalidate() -> None:
    cache.delete(_CACHE_KEY)


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


def is_enabled(
    key: str, *, user_id: UUID | None = None, role_codes: Iterable[str] = (), company_id: UUID | None = None
) -> bool:
    flag = _all_flags().get(key)
    if flag is None:
        return False
    return _evaluate(flag, user_id, role_codes, company_id)


def effective_flags(*, user_id: UUID | None, role_codes: Iterable[str], company_id: UUID | None) -> dict[str, bool]:
    role_codes = list(role_codes)
    return {key: _evaluate(flag, user_id, role_codes, company_id) for key, flag in _all_flags().items()}


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
