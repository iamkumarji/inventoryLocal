import pytest

from apps.core.models import FeatureFlag
from apps.masterdata.models import ItemBarcode

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def inventory_enabled(db):
    for key in ("module.inventory", "module.masterdata"):
        FeatureFlag.objects.create(key=key, enabled_default=True)


def test_scan_resolves_item_codes_as_well_as_barcodes(api_for, make_user, grant, org, books, make_item):
    """Regression: the scan box had to try the item lookup first and fall back to scan on a 404 (logged as a
    browser error for every serial, batch or bin scanned). The scan endpoint now resolves item codes too."""
    user = make_user()
    grant(user, ["masterdata.item.read"], org)
    item = make_item(code="BOLT-M10")
    ItemBarcode.objects.create(organization=org, item=item, barcode="8901234567890")
    client = api_for(user, company=books)

    by_code = client.get("/api/v1/inventory/scan/", {"code": "BOLT-M10"})
    assert by_code.status_code == 200
    assert by_code.json() == {"kind": "item", "item_id": str(item.pk), "item_code": "BOLT-M10", "uom_id": None}
    by_barcode = client.get("/api/v1/inventory/scan/", {"code": "8901234567890"})
    assert by_barcode.json()["item_id"] == str(item.pk)
    assert client.get("/api/v1/inventory/scan/", {"code": "NOPE"}).status_code == 404
