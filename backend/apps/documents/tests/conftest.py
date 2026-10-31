import pytest

from apps.core.models import FeatureFlag


@pytest.fixture(autouse=True)
def modules(db):
    for key in ("module.collaboration", "module.documents"):
        FeatureFlag.objects.get_or_create(key=key, defaults={"enabled_default": True})


@pytest.fixture
def record(company, make_department):
    """A business record to comment on / attach to: an organization.department."""
    return make_department(company, code="QA")


@pytest.fixture
def ref(record):
    return {"resource_type": "organization.department", "resource_id": str(record.pk)}
