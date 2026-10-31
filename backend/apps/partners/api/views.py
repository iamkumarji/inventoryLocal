from django.db import transaction
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.authorization import pdp
from apps.partners import services
from apps.partners.models import (
    CustomerProfile,
    Partner,
    PartnerAddress,
    PartnerBankAccount,
    PartnerContact,
    SupplierProfile,
)
from apps.shared.crud import create_record, update_record
from apps.shared.viewsets import MasterDataViewSet, master_schema

from . import serializers as s


@master_schema
class PartnerViewSet(MasterDataViewSet):
    authz_resource = "partners.partner"
    authz_actions = {
        "add_address": "update",
        "add_contact": "update",
        "supplier_terms": "partners.supplier.update",
        "customer_terms": "partners.customer.update",
        "bank_accounts": "partners.bank_account.read",
        "add_bank_account": "partners.bank_account.update",
        "review_bank_account": "partners.bank_account.approve",
        "approve_supplier": "partners.supplier.approve",
    }
    queryset = Partner.objects.select_related("supplier_profile", "customer_profile").prefetch_related(
        "addresses", "contacts"
    )
    serializer_class = s.PartnerSerializer
    editable_fields = (
        "name",
        "legal_name",
        "is_supplier",
        "is_customer",
        "gst_registration",
        "gstin",
        "pan",
        "state_code",
        "email",
        "phone",
        "is_blocked",
        "blocked_reason",
        "is_active",
    )
    filterset_fields = ["is_supplier", "is_customer", "is_blocked", "is_active", "state_code"]
    search_fields = ["code", "name", "gstin"]

    def create(self, request, *args, **kwargs):
        with transaction.atomic():
            response = super().create(request, *args, **kwargs)
            partner = Partner.objects.get(pk=response.data["id"])
            if partner.is_supplier:
                SupplierProfile.objects.create(
                    organization_id=partner.organization_id,
                    partner=partner,
                    created_by=request.user,
                    updated_by=request.user,
                )
            if partner.is_customer:
                CustomerProfile.objects.create(
                    organization_id=partner.organization_id,
                    partner=partner,
                    created_by=request.user,
                    updated_by=request.user,
                )
        return Response(
            s.PartnerSerializer(self.get_queryset().get(pk=partner.pk)).data, status=status.HTTP_201_CREATED
        )

    def _child(self, request, model, serializer_cls):
        partner = self.get_object()
        data = serializer_cls(data=request.data)
        data.is_valid(raise_exception=True)
        create_record(
            self.actor,
            model,
            {**data.validated_data, "partner": partner, "organization_id": partner.organization_id},
            resource=pdp.Resource.of(partner),
        )
        return Response(
            s.PartnerSerializer(self.get_queryset().get(pk=partner.pk)).data, status=status.HTTP_201_CREATED
        )

    @extend_schema(request=s.AddressSerializer, responses={201: s.PartnerSerializer})
    @action(detail=True, methods=["post"], url_path="addresses")
    def add_address(self, request, pk=None):
        return self._child(request, PartnerAddress, s.AddressSerializer)

    @extend_schema(request=s.ContactSerializer, responses={201: s.PartnerSerializer})
    @action(detail=True, methods=["post"], url_path="contacts")
    def add_contact(self, request, pk=None):
        return self._child(request, PartnerContact, s.ContactSerializer)

    def _terms(self, request, profile_attr, serializer_cls, editable, permission):
        partner = self.get_object()
        profile = getattr(partner, profile_attr, None)
        if profile is None:
            return Response({"detail": "Not enabled for this partner."}, status=status.HTTP_404_NOT_FOUND)
        data = serializer_cls(profile, data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        pdp.require(self.actor, permission, pdp.Resource.of(partner))
        update_record(
            self.actor, profile, dict(data.validated_data), request.data.get("version", profile.version), editable
        )
        return Response(s.PartnerSerializer(self.get_queryset().get(pk=partner.pk)).data)

    @extend_schema(request=s.SupplierProfileSerializer, responses=s.PartnerSerializer)
    @action(detail=True, methods=["patch"], url_path="supplier-terms")
    def supplier_terms(self, request, pk=None):
        return self._terms(
            request,
            "supplier_profile",
            s.SupplierProfileSerializer,
            ("payment_terms_days", "currency", "default_lead_time_days", "tds_section"),
            "partners.supplier.update",
        )

    @extend_schema(request=s.CustomerProfileSerializer, responses=s.PartnerSerializer)
    @action(detail=True, methods=["patch"], url_path="customer-terms")
    def customer_terms(self, request, pk=None):
        return self._terms(
            request,
            "customer_profile",
            s.CustomerProfileSerializer,
            ("credit_limit", "credit_days", "on_credit_hold"),
            "partners.customer.update",
        )

    @extend_schema(responses=s.BankAccountSerializer(many=True))
    @action(detail=True, methods=["get"], url_path="bank-accounts", pagination_class=None)
    def bank_accounts(self, request, pk=None):
        partner = self.get_object()
        return Response(s.BankAccountSerializer(partner.bank_accounts.order_by("-created_at"), many=True).data)

    @extend_schema(request=s.BankAccountCreateSerializer, responses={201: s.BankAccountSerializer})
    @bank_accounts.mapping.post
    def add_bank_account(self, request, pk=None):
        partner = self.get_object()
        data = s.BankAccountCreateSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        account = services.add_bank_account(self.actor, partner, **data.validated_data)
        return Response(s.BankAccountSerializer(account).data, status=status.HTTP_201_CREATED)

    @extend_schema(
        request=s.ReviewSerializer,
        responses=s.BankAccountSerializer,
        parameters=[OpenApiParameter("account_id", OpenApiTypes.UUID, OpenApiParameter.PATH)],
    )
    @action(detail=True, methods=["post"], url_path=r"bank-accounts/(?P<account_id>[^/.]+)/review")
    def review_bank_account(self, request, pk=None, account_id=None):
        partner = self.get_object()
        account = PartnerBankAccount.objects.get(pk=account_id, partner=partner)
        data = s.ReviewSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        account = services.review_bank_account(self.actor, account, **data.validated_data)
        return Response(s.BankAccountSerializer(account).data)

    @extend_schema(request=s.ReviewSerializer, responses=s.PartnerSerializer)
    @action(detail=True, methods=["post"], url_path="approve-supplier")
    def approve_supplier(self, request, pk=None):
        data = s.ReviewSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        services.approve_supplier(self.actor, self.get_object(), approve=data.validated_data["approve"])
        return Response(s.PartnerSerializer(self.get_queryset().get(pk=pk)).data)
