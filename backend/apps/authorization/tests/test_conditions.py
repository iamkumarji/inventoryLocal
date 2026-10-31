from decimal import Decimal
from uuid import uuid4

import pytest
from django.db.models import Q

from apps.authorization.conditions import Attributes, ConditionError, evaluate, to_q, validate


def attrs(**resource):
    return Attributes(
        subject={"id": "u1", "role_codes": ["buyer"]},
        resource=resource,
        env={"time": "21:30", "ip_internal": False},
        action={"verb": "approve"},
    )


@pytest.mark.parametrize(
    ("condition", "expected"),
    [
        ({"attr": "resource.amount", "op": "gt", "value": 100}, True),
        ({"attr": "resource.amount", "op": "lte", "value": "150.25"}, True),
        ({"attr": "resource.amount", "op": "lt", "value": 150.25}, False),
        ({"attr": "resource.status", "op": "in", "value": ["draft", "submitted"]}, True),
        ({"attr": "resource.status", "op": "not_in", "value": ["posted"]}, True),
        ({"attr": "subject.role_codes", "op": "contains", "value": "buyer"}, True),
        ({"attr": "resource.code", "op": "starts_with", "value": "PO/"}, True),
        ({"attr": "resource.missing", "op": "exists"}, False),
        ({"attr": "resource.missing", "op": "exists", "value": False}, True),
        ({"attr": "resource.owner", "op": "eq", "value": {"attr": "subject.id"}}, True),
        (
            {
                "all": [
                    {"attr": "env.ip_internal", "op": "eq", "value": False},
                    {"not": {"attr": "action.verb", "op": "eq", "value": "read"}},
                ]
            },
            True,
        ),
        (
            {
                "any": [
                    {"attr": "resource.amount", "op": "gt", "value": 1000},
                    {"attr": "resource.status", "op": "eq", "value": "posted"},
                ]
            },
            False,
        ),
        ({}, True),
    ],
)
def test_evaluate(condition, expected):
    a = attrs(amount=Decimal("150.25"), status="draft", code="PO/26/1", owner="u1")
    assert evaluate(condition, a) is expected


def test_null_comparisons_are_false():
    a = attrs()
    assert evaluate({"attr": "resource.amount", "op": "gt", "value": 0}, a) is False
    assert evaluate({"attr": "resource.amount", "op": "lt", "value": 0}, a) is False
    assert evaluate({"attr": "resource.amount", "op": "eq", "value": None}, a) is True


def test_uuid_and_string_compare_equal():
    value = uuid4()
    assert evaluate({"attr": "resource.id", "op": "eq", "value": str(value)}, attrs(id=value))


def test_time_between_wraps_midnight():
    a = attrs()
    assert evaluate({"attr": "env.time", "op": "time_between", "value": ["20:00", "06:00"]}, a)
    assert not evaluate({"attr": "env.time", "op": "time_between", "value": ["08:00", "20:00"]}, a)


def test_errors_raise():
    with pytest.raises(ConditionError):
        evaluate({"attr": "resource.amount", "op": "gt", "value": "abc"}, attrs(amount=5))
    with pytest.raises(ConditionError):
        evaluate({"attr": "bogus.x", "op": "eq", "value": 1}, attrs())
    with pytest.raises(ConditionError):
        evaluate({"attr": "resource.x", "op": "nope", "value": 1}, attrs())


def test_lazy_attributes_resolved_once():
    calls = []

    def limit():
        calls.append(1)
        return Decimal("10")

    a = Attributes(env={"approval_limit": limit})
    assert evaluate({"attr": "env.approval_limit", "op": "eq", "value": 10}, a)
    assert evaluate({"attr": "env.approval_limit", "op": "gte", "value": 5}, a)
    assert len(calls) == 1


def test_validate_reports_problems():
    assert validate({"attr": "resource.a", "op": "eq", "value": 1}) == []
    errors = validate({"all": [{"attr": "x", "op": "zz"}, {"attr": "resource.a", "op": "in", "value": 3}]})
    assert len(errors) == 3
    assert validate({"all": []}) == ["condition.all: must be a non-empty list"]


def test_to_q_translation():
    a = attrs()
    fields = {"created_by_id": "created_by_id", "status": "status", "amount": "amount"}.get
    q = to_q({"attr": "resource.created_by_id", "op": "eq", "value": {"attr": "subject.id"}}, a, fields)
    assert q == Q(created_by_id="u1")
    q = to_q(
        {
            "all": [
                {"attr": "resource.status", "op": "in", "value": ["a"]},
                {"attr": "resource.amount", "op": "gt", "value": 5},
            ]
        },
        a,
        fields,
    )
    assert q == Q(status__in=["a"]) & Q(amount__gt=5)
    # Subject/env-only conditions collapse to a constant filter.
    assert to_q({"attr": "env.ip_internal", "op": "eq", "value": False}, a, fields) == Q()
    # Untranslatable: unknown field or unsupported operator.
    assert to_q({"attr": "resource.secret", "op": "eq", "value": 1}, a, fields) is None
    assert to_q({"attr": "resource.status", "op": "starts_with", "value": "x"}, a, fields) is None
