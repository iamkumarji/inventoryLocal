"""Base viewset for business documents: list/retrieve plus service-backed actions."""

from rest_framework import mixins, serializers, status
from rest_framework.response import Response

from apps.authorization.drf import ERPGenericViewSet


class VersionBody(serializers.Serializer):
    version = serializers.IntegerField(required=False)


class DecisionBody(serializers.Serializer):
    approve = serializers.BooleanField()
    comment = serializers.CharField(required=False, allow_blank=True, default="")
    version = serializers.IntegerField(required=False)


class ReasonBody(serializers.Serializer):
    reason = serializers.CharField(max_length=500)
    version = serializers.IntegerField(required=False)


class DocumentViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    write_serializer_class = None

    def respond(self, doc, created: bool = False):
        fresh = self.get_queryset().model.objects.get(pk=doc.pk)
        return Response(
            self.get_serializer(fresh).data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK
        )

    def validated(self, serializer_cls=None, many=False):
        cls = serializer_cls or self.write_serializer_class or self.get_serializer_class()
        data = cls(data=self.request.data, many=many, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        return data.validated_data

    def version(self):
        value = self.request.data.get("version")
        return int(value) if value not in (None, "") else None
