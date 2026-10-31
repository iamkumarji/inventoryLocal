"""Permission catalogue declared in code.

Each module exposes `PERMISSIONS: list[PermissionSpec]` in `apps/<module>/permissions.py`.
`manage.py sync_permissions` upserts them into the `permissions` table.
"""

import importlib
import re
from collections.abc import Iterable
from dataclasses import dataclass

from django.apps import apps

CODE_RE = re.compile(r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$")


@dataclass(frozen=True)
class PermissionSpec:
    code: str
    description: str = ""
    is_sensitive: bool = False
    requires_mfa: bool = False

    def __post_init__(self):
        if not CODE_RE.match(self.code):
            raise ValueError(f"Invalid permission code: {self.code!r}")

    @property
    def module(self) -> str:
        return self.code.split(".")[0]

    @property
    def resource(self) -> str:
        return self.code.split(".")[1]

    @property
    def action(self) -> str:
        return self.code.split(".")[2]


def resource_permissions(
    resource: str,
    actions: Iterable[str],
    label: str,
    *,
    sensitive: Iterable[str] = (),
    mfa: Iterable[str] = (),
) -> list[PermissionSpec]:
    """Build specs for '<module>.<resource>' and a list of actions."""
    sensitive, mfa = set(sensitive), set(mfa)
    return [
        PermissionSpec(
            code=f"{resource}.{action}",
            description=f"{action.replace('_', ' ').capitalize()} {label}",
            is_sensitive=action in sensitive or action in mfa,
            requires_mfa=action in mfa,
        )
        for action in actions
    ]


def collect() -> dict[str, PermissionSpec]:
    specs: dict[str, PermissionSpec] = {}
    for config in apps.get_app_configs():
        if not config.name.startswith("apps."):
            continue
        try:
            module = importlib.import_module(f"{config.name}.permissions")
        except ModuleNotFoundError as exc:
            if exc.name == f"{config.name}.permissions":
                continue
            raise
        # A module may expose `permissions()` instead of PERMISSIONS when its catalogue depends on
        # settings; it's evaluated on every sync rather than frozen at import time.
        specs_source = (
            module.permissions()
            if callable(getattr(module, "permissions", None))
            else getattr(module, "PERMISSIONS", [])
        )
        for spec in specs_source:
            if spec.code in specs:
                raise ValueError(f"Duplicate permission code {spec.code}")
            specs[spec.code] = spec
    return specs
