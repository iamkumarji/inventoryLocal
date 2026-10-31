from decimal import Decimal

import pytest

from apps.core.models import FeatureFlag
from apps.masterdata.models import ItemWarehousePolicy, UomConversion

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def masterdata_enabled(db):
    FeatureFlag.objects.create(key="module.masterdata", enabled_default=True)


def _field_errors(response) -> dict:
    return {e["field"]: e["message"] for e in response.json().get("errors", [])}


def test_duplicate_reorder_settings_name_the_warehouse(api_for, make_user, grant, books, plant, make_item):
    """Regression: a second policy for the same item and warehouse said "A record with this code already
    exists." on a `code` field the form doesn't have, so the person saw nothing."""
    planner = make_user()
    grant(planner, ["masterdata.item_policy.create", "masterdata.item_policy.read"], books)
    item = make_item()
    client = api_for(planner, company=books)
    body = {"company": str(books.pk), "item": str(item.pk), "warehouse": str(plant["rm"].pk), "reorder_level": "5"}
    assert client.post("/api/v1/masterdata/item-policies/", body, format="json").status_code == 201
    response = client.post("/api/v1/masterdata/item-policies/", {**body, "reorder_level": "8"}, format="json")
    assert response.status_code == 400
    assert "already has reorder settings for this warehouse" in _field_errors(response)["warehouse"]
    assert ItemWarehousePolicy.objects.filter(item=item).count() == 1


def test_duplicate_conversion_names_the_units(api_for, make_user, grant, org, uoms, make_item):
    """Regression: duplicate conversions were reported against a non-existent `code` field."""
    user = make_user()
    grant(user, ["masterdata.uom.create", "masterdata.uom.read", "masterdata.item.read"], org)
    client = api_for(user)
    # The fixture already has a general 1 BAG = 25 KG.
    general = {"from_uom": str(uoms["bag"].pk), "to_uom": str(uoms["kg"].pk), "factor": "30"}
    response = client.post("/api/v1/masterdata/uom-conversions/", general, format="json")
    assert response.status_code == 400
    assert _field_errors(response)["to_uom"].startswith("A conversion from BAG to KG already exists.")

    # An item-specific conversion is a different rule; a second one for the same item is a duplicate.
    item = make_item()
    specific = {**general, "item": str(item.pk), "factor": "50"}
    assert client.post("/api/v1/masterdata/uom-conversions/", specific, format="json").status_code == 201
    response = client.post("/api/v1/masterdata/uom-conversions/", specific, format="json")
    assert response.status_code == 400
    assert "BAG to KG for this item already exists" in _field_errors(response)["to_uom"]
    assert UomConversion.objects.filter(item=item).get().factor == Decimal("50")
