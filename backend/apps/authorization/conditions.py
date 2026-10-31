"""ABAC condition language (docs/RBAC_ABAC.md §3.2).

    {"all": [...]} | {"any": [...]} | {"not": {...}}
    {"attr": "resource.amount", "op": "gt", "value": 100000}
    {"attr": "resource.created_by_id", "op": "eq", "value": {"attr": "subject.id"}}

Semantics: a missing attribute is None; every comparison involving None is
False except `exists`, `eq None` and `ne None`. Evaluation errors raise
ConditionError so callers can fail closed.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import time
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from django.db.models import Q

OPS = {"eq", "ne", "lt", "lte", "gt", "gte", "in", "not_in", "contains", "exists", "starts_with", "time_between"}
NAMESPACES = {"subject", "resource", "action", "env"}
_SQL_OPS = {"eq", "ne", "lt", "lte", "gt", "gte", "in", "not_in", "exists"}
_MAX_DEPTH = 10


class ConditionError(Exception):
    pass


class Attributes:
    """Attribute source. Values in a namespace may be callables, resolved lazily once."""

    def __init__(self, **namespaces: Mapping[str, Any]):
        self._ns = {name: dict(values) for name, values in namespaces.items()}

    def get(self, ref: str) -> Any:
        namespace, _, name = ref.partition(".")
        if namespace not in NAMESPACES or not name:
            raise ConditionError(f"Invalid attribute reference {ref!r}")
        values = self._ns.get(namespace, {})
        value = values.get(name)
        if callable(value):
            value = value()
            values[name] = value
        return value


def _norm(value: Any) -> Any:
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_norm(v) for v in value]
    return value


def _numeric_pair(left: Any, right: Any) -> tuple[Any, Any]:
    """Compare numbers as Decimal when either side is numeric (never floats against money)."""
    numeric = (int, float, Decimal)
    if isinstance(left, bool) or isinstance(right, bool):
        return left, right
    if isinstance(left, numeric) or isinstance(right, numeric):
        try:
            return Decimal(str(left)), Decimal(str(right))
        except (InvalidOperation, ValueError) as exc:
            raise ConditionError(f"Cannot compare {left!r} and {right!r} numerically") from exc
    return left, right


def _parse_time(value: Any) -> time:
    if isinstance(value, time):
        return value
    try:
        hours, minutes = str(value).split(":")[:2]
        return time(int(hours), int(minutes))
    except (ValueError, TypeError) as exc:
        raise ConditionError(f"Invalid time {value!r}") from exc


def _compare(op: str, left: Any, right: Any) -> bool:
    if op == "exists":
        return (left is not None) == bool(True if right is None else right)
    if op == "eq":
        if left is None or right is None:
            return left is None and right is None
        a, b = _numeric_pair(_norm(left), _norm(right))
        return a == b
    if op == "ne":
        if left is None or right is None:
            return (left is None) != (right is None)
        a, b = _numeric_pair(_norm(left), _norm(right))
        return a != b
    if left is None or right is None:
        return False
    left, right = _norm(left), _norm(right)
    if op in {"lt", "lte", "gt", "gte"}:
        a, b = _numeric_pair(left, right)
        try:
            return {"lt": a < b, "lte": a <= b, "gt": a > b, "gte": a >= b}[op]
        except TypeError as exc:
            raise ConditionError(f"Cannot order {left!r} and {right!r}") from exc
    if op in {"in", "not_in"}:
        if not isinstance(right, list):
            raise ConditionError(f"'{op}' requires a list value")
        found = any(_compare("eq", left, item) for item in right)
        return found if op == "in" else not found
    if op == "contains":
        if isinstance(left, list):
            return any(_compare("eq", item, right) for item in left)
        return str(right) in str(left)
    if op == "starts_with":
        return str(left).startswith(str(right))
    if op == "time_between":
        if not isinstance(right, list) or len(right) != 2:
            raise ConditionError("'time_between' requires [start, end]")
        current, start, end = _parse_time(left), _parse_time(right[0]), _parse_time(right[1])
        return start <= current <= end if start <= end else (current >= start or current <= end)
    raise ConditionError(f"Unknown operator {op!r}")


def _resolve_value(value: Any, attrs: Attributes) -> Any:
    if isinstance(value, dict) and set(value) == {"attr"}:
        return attrs.get(value["attr"])
    return value


def evaluate(condition: Mapping | None, attrs: Attributes, _depth: int = 0) -> bool:
    """Evaluate a condition; an empty condition is True."""
    if not condition:
        return True
    if _depth > _MAX_DEPTH:
        raise ConditionError("Condition nesting too deep")
    if not isinstance(condition, Mapping):
        raise ConditionError("Condition must be an object")
    if "all" in condition:
        return all(evaluate(c, attrs, _depth + 1) for c in condition["all"])
    if "any" in condition:
        return any(evaluate(c, attrs, _depth + 1) for c in condition["any"])
    if "not" in condition:
        return not evaluate(condition["not"], attrs, _depth + 1)
    op = condition.get("op")
    if op not in OPS or "attr" not in condition:
        raise ConditionError(f"Malformed comparison {condition!r}")
    return _compare(op, attrs.get(condition["attr"]), _resolve_value(condition.get("value"), attrs))


def validate(condition: Any, _depth: int = 0, _path: str = "condition") -> list[str]:
    """Return a list of problems (empty = valid). Used by the policy admin API."""
    if condition in (None, {}):
        return []
    if _depth > _MAX_DEPTH:
        return [f"{_path}: nesting deeper than {_MAX_DEPTH}"]
    if not isinstance(condition, Mapping):
        return [f"{_path}: must be an object"]
    for key in ("all", "any"):
        if key in condition:
            items = condition[key]
            if not isinstance(items, list) or not items:
                return [f"{_path}.{key}: must be a non-empty list"]
            return [e for i, c in enumerate(items) for e in validate(c, _depth + 1, f"{_path}.{key}[{i}]")]
    if "not" in condition:
        return validate(condition["not"], _depth + 1, f"{_path}.not")
    errors = []
    ref = condition.get("attr")
    if not isinstance(ref, str) or ref.partition(".")[0] not in NAMESPACES or not ref.partition(".")[2]:
        errors.append(f"{_path}.attr: must be '<subject|resource|action|env>.<name>'")
    if condition.get("op") not in OPS:
        errors.append(f"{_path}.op: must be one of {sorted(OPS)}")
    value = condition.get("value")
    if isinstance(value, dict) and (set(value) != {"attr"} or not isinstance(value["attr"], str)):
        errors.append(f"{_path}.value: object values must be {{'attr': '<ref>'}}")
    if condition.get("op") in {"in", "not_in", "time_between"} and not isinstance(value, list):
        errors.append(f"{_path}.value: must be a list for '{condition.get('op')}'")
    return errors


def referenced_attrs(condition: Any) -> set[str]:
    refs: set[str] = set()
    if isinstance(condition, Mapping):
        if "attr" in condition and isinstance(condition["attr"], str):
            refs.add(condition["attr"])
        value = condition.get("value")
        if isinstance(value, Mapping) and isinstance(value.get("attr"), str):
            refs.add(value["attr"])
        for key in ("all", "any"):
            for child in condition.get(key, []) or []:
                refs |= referenced_attrs(child)
        if "not" in condition:
            refs |= referenced_attrs(condition["not"])
    return refs


def references_resource(condition: Any) -> bool:
    return any(ref.startswith("resource.") for ref in referenced_attrs(condition))


_FALSE_Q = Q(pk__in=[])


def to_q(condition: Any, attrs: Attributes, field_for: Callable[[str], str | None]) -> Q | None:
    """Translate a condition into a Django Q filter for list endpoints.

    Resource attributes map to model fields via `field_for`; subject/env
    attributes are resolved to literals now. Returns None if the condition
    can't be expressed in SQL (callers decide how to fail).
    """
    if not condition:
        return Q()
    if not references_resource(condition):
        try:
            return Q() if evaluate(condition, attrs) else _FALSE_Q
        except ConditionError:
            return None
    if "all" in condition or "any" in condition:
        key = "all" if "all" in condition else "any"
        parts = [to_q(c, attrs, field_for) for c in condition[key]]
        if any(p is None for p in parts):
            return None
        combined = parts[0]
        for part in parts[1:]:
            combined = (combined & part) if key == "all" else (combined | part)
        return combined
    if "not" in condition:
        inner = to_q(condition["not"], attrs, field_for)
        return None if inner is None else ~inner
    op, ref = condition.get("op"), condition.get("attr", "")
    value = condition.get("value")
    if op not in _SQL_OPS or not ref.startswith("resource."):
        return None
    if isinstance(value, Mapping):
        if str(value.get("attr", "")).startswith("resource."):
            return None
        try:
            value = attrs.get(value["attr"])
        except ConditionError:
            return None
    field = field_for(ref.partition(".")[2])
    if field is None:
        return None
    if op == "exists":
        return Q(**{f"{field}__isnull": not (True if value is None else bool(value))})
    if op == "eq":
        return Q(**{f"{field}__isnull": True}) if value is None else Q(**{field: value})
    if op == "ne":
        if value is None:
            return Q(**{f"{field}__isnull": False})
        return Q(**{f"{field}__isnull": False}) & ~Q(**{field: value})
    if value is None:
        return _FALSE_Q
    if op in {"in", "not_in"}:
        if not isinstance(value, list):
            return None
        q = Q(**{f"{field}__in": value})
        return q if op == "in" else (Q(**{f"{field}__isnull": False}) & ~q)
    return Q(**{f"{field}__{op}": value})
