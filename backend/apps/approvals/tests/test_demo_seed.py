import pytest
from django.core.management import CommandError, call_command

from apps.approvals import demo, registry
from apps.approvals.models import ApprovalRequest
from apps.authorization.seeding import seed_templates, sync_permissions

pytestmark = pytest.mark.django_db


def test_seed_refuses_outside_development():
    with pytest.raises(CommandError, match="development-only"):
        call_command("seed_demo")


def test_seed_runs_through_real_services(settings, org, company, fiscal_year):
    settings.DEBUG = True
    settings.ERP = {**settings.ERP, "DEMO_DATA": True}
    demo.register()
    try:
        sync_permissions()
        seed_templates(org)
        call_command("seed_demo", organization=org.code)
        requests = ApprovalRequest.objects.filter(document_type=demo.DOCUMENT_TYPE)
        assert requests.count() == 3
        two_level = requests.get(amount="240000")
        assert list(two_level.steps.values_list("status", flat=True)) == ["approved", "pending"]
        with pytest.raises(CommandError, match="already present"):
            call_command("seed_demo", organization=org.code)
    finally:
        registry.unregister(demo.DOCUMENT_TYPE)
