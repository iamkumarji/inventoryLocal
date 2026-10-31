"""Test helpers shared by the HR and Expenses test suites."""

from __future__ import annotations

from datetime import date

from apps.authorization.models import AbacPolicy
from apps.authorization.templates import POLICY_TEMPLATES
from apps.core.models import FeatureFlag
from apps.hr import services


def enable_modules(*keys: str) -> None:
    for key in keys:
        FeatureFlag.objects.get_or_create(key=key, defaults={"enabled_default": True})


def enable_policy(org, code: str) -> AbacPolicy:
    tpl = next(t for t in POLICY_TEMPLATES if t["code"] == code)
    return AbacPolicy.objects.create(organization=org, **tpl)


def make_employee(system_ctx, company, department, code: str, *, user=None, joined: date | None = None, **kw):
    employee = services.create_employee(
        system_ctx,
        company=company,
        department=department,
        code=code,
        full_name=kw.pop("full_name", f"Employee {code}"),
        date_of_joining=joined or date(date.today().year - 1, 1, 1),
        user=user,
        **kw,
    )
    if user is not None:
        user.refresh_from_db()  # picks up user.employee_id (subject.employee_id for ABAC)
    return employee
