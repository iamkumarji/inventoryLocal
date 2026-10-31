"""Master-data viewset: list/retrieve/create/partial_update with PDP checks and optimistic locking."""

from drf_spectacular.utils import extend_schema
from rest_framework import mixins, serializers, status
from rest_framework.response import Response

from apps.authorization import pdp
from apps.authorization.drf import ERPGenericViewSet

from .crud import create_record, update_record


class MasterDataViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    """Subclasses set: queryset, serializer_class, authz_resource, editable_fields.

    `create_resource(validated)` returns the Resource checked for `create` (defaults to the
    caller's organization for shared master data, or the given company).
    """

    editable_fields: tuple[str, ...] = ()
    ordering = ["code"]

    def create_resource(self, validated: dict) -> pdp.Resource:
        model = self.get_queryset().model
        if "company" in validated:
            return pdp.Resource.ref(model.authz_resource_type, company_id=validated["company"].pk)
        return pdp.Resource.ref(
            model.authz_resource_type,
            scope_fields={"shared": "organization_id"},
            organization_id=self.request.user.organization_id,
        )

    def prepare_create(self, validated: dict) -> dict:
        model = self.get_queryset().model
        if "organization" in {f.name for f in model._meta.concrete_fields} and "organization" not in validated:
            validated["organization_id"] = self.request.user.organization_id
        return validated

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = self.prepare_create(dict(serializer.validated_data))
        instance = create_record(self.actor, self.get_queryset().model, data, resource=self.create_resource(data))
        return Response(self.get_serializer(instance).data, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        instance = self.get_object()
        serializer = self.get_serializer(instance, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        data = {k: v for k, v in serializer.validated_data.items() if k != "version"}
        try:
            version = int(request.data.get("version")) if request.data.get("version") is not None else None
        except (TypeError, ValueError):
            raise serializers.ValidationError({"version": ["Must be an integer."]}) from None
        instance = update_record(self.actor, instance, data, version, self.editable_fields)
        return Response(self.get_serializer(instance).data)


def master_schema(viewset_cls):
    """Per-class OpenAPI docs (avoids sharing decorated base methods across subclasses)."""

    # Wrap the class's own handlers when it defines them (e.g. partners create profiles too);
    # replacing them with the base implementation would silently skip that logic.
    own_create = viewset_cls.__dict__.get("create") or MasterDataViewSet.create
    own_update = viewset_cls.__dict__.get("partial_update") or MasterDataViewSet.partial_update

    def create(self, request, *args, **kwargs):
        return own_create(self, request, *args, **kwargs)

    def partial_update(self, request, *args, **kwargs):
        return own_update(self, request, *args, **kwargs)

    ser = viewset_cls.serializer_class
    viewset_cls.create = extend_schema(request=ser, responses={201: ser})(create)
    viewset_cls.partial_update = extend_schema(
        request=ser, responses=ser, description="Partial update; send `version` for optimistic locking."
    )(partial_update)
    return viewset_cls
