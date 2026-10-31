import secrets

from django.conf import settings
from django.db.models import Q
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authorization import pdp
from apps.authorization.context import actor_for
from apps.authorization.drf import ERPGenericViewSet
from apps.core import flags
from apps.core.exceptions import NotFound
from apps.core.idempotency import idempotency_header, idempotent
from apps.core.net import client_ip
from apps.identity import services
from apps.identity.models import AuthSession, MFADevice, User
from apps.organization.models import Company

from .serializers import (
    CodeSerializer,
    LoginSerializer,
    MFALoginSerializer,
    PasswordChangeSerializer,
    SessionSerializer,
    UserCreateSerializer,
    UserSerializer,
    UserUpdateSerializer,
)

ERP = settings.ERP


def _client(request, client_type: str, device_id: str = "") -> services.ClientInfo:
    return services.ClientInfo(
        client_type=client_type,
        ip=client_ip(request),
        user_agent=request.META.get("HTTP_USER_AGENT", "")[:300],
        device_id=device_id,
        request_id=getattr(request, "request_id", ""),
    )


def _set_cookies(response: Response, token: str, session: AuthSession) -> str:
    max_age = int((session.absolute_expires_at - timezone.now()).total_seconds())
    common = {
        "max_age": max_age,
        "secure": ERP["COOKIE_SECURE"],
        "samesite": "Lax",
        "path": "/",
        "domain": ERP["COOKIE_DOMAIN"],
    }
    response.set_cookie(ERP["SESSION_COOKIE_NAME"], token, httponly=True, **common)
    csrf_token = secrets.token_urlsafe(32)
    response.set_cookie(ERP["CSRF_COOKIE_NAME"], csrf_token, httponly=False, **common)
    return csrf_token


def _clear_cookies(response: Response) -> None:
    for name in (ERP["SESSION_COOKIE_NAME"], ERP["CSRF_COOKIE_NAME"]):
        response.delete_cookie(name, path="/", domain=ERP["COOKIE_DOMAIN"], samesite="Lax")


def _session_response(result: services.LoginResult) -> Response:
    session = result.session
    body = {
        "status": result.status,
        "user": {"id": str(result.user.pk), "email": result.user.email, "full_name": result.user.full_name},
        "session": {
            "id": str(session.pk),
            "client_type": session.client_type,
            "absolute_expires_at": session.absolute_expires_at,
            "restricted_reason": session.restricted_reason or None,
        },
    }
    if session.client_type == AuthSession.ClientType.WEB:
        response = Response(body)
        body["csrf_token"] = _set_cookies(response, result.token, session)
        response.data = body
        return response
    body["token"] = result.token  # mobile/API clients store it in secure device storage
    return Response(body)


LOGIN_RESPONSE = inline_serializer(
    "LoginResponse",
    {
        "status": serializers.ChoiceField(
            choices=["authenticated", "mfa_required", "mfa_enrollment_required", "password_change_required"]
        ),
        "challenge_token": serializers.CharField(required=False),
        "token": serializers.CharField(required=False),
        "csrf_token": serializers.CharField(required=False),
    },
)


class LoginView(APIView):
    authz_public = True
    authentication_classes: list = []
    throttle_scope = "auth"

    @extend_schema(request=LoginSerializer, responses=LOGIN_RESPONSE, tags=["auth"])
    def post(self, request):
        data = LoginSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        result = services.login(v["email"], v["password"], _client(request, v["client_type"], v.get("device_id", "")))
        if result.status == "mfa_required":
            return Response({"status": "mfa_required", "challenge_token": result.challenge_token})
        return _session_response(result)


class MFALoginView(APIView):
    authz_public = True
    authentication_classes: list = []
    throttle_scope = "auth"

    @extend_schema(request=MFALoginSerializer, responses=LOGIN_RESPONSE, tags=["auth"])
    def post(self, request):
        data = MFALoginSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        from apps.core.crypto import sha256_hex
        from apps.identity.models import AuthChallenge

        challenge = AuthChallenge.objects.filter(
            challenge_hash=sha256_hex(data.validated_data["challenge_token"])
        ).first()
        client = _client(
            request, challenge.client_type if challenge else "web", challenge.device_id if challenge else ""
        )
        result = services.complete_mfa_login(
            data.validated_data["challenge_token"], data.validated_data["code"], client
        )
        return _session_response(result)


class LogoutView(APIView):
    authz_authenticated_only = True
    authz_allow_restricted = True

    @extend_schema(request=None, responses={204: None}, tags=["auth"])
    def post(self, request):
        services.revoke_session(request.auth, "logout", actor_for(request))
        response = Response(status=status.HTTP_204_NO_CONTENT)
        _clear_cookies(response)
        return response


class MeView(APIView):
    authz_authenticated_only = True
    authz_allow_restricted = True

    @extend_schema(responses=inline_serializer("Me", {"user": serializers.DictField()}), tags=["auth"])
    def get(self, request):
        ctx = actor_for(request)
        user, session = request.user, request.auth
        snapshot_companies = pdp.accessible_company_ids(user.pk)
        companies = Company.objects.filter(pk__in=snapshot_companies, is_active=True).order_by("code")
        restricted = bool(session.restricted_reason)
        permissions = {"codes": [], "grants": {}, "conditional": []} if restricted else pdp.effective_permissions(ctx)
        from apps.authorization.snapshot import get_snapshot

        snapshot = get_snapshot(user.pk)
        device = MFADevice.objects.filter(user=user, confirmed_at__isnull=False).first()
        return Response(
            {
                "user": {
                    "id": str(user.pk),
                    "email": user.email,
                    "full_name": user.full_name,
                    "phone": user.phone,
                    "organization_id": str(user.organization_id) if user.organization_id else None,
                    "is_platform_operator": user.is_platform_operator,
                    "employee_id": str(user.employee_id) if user.employee_id else None,
                },
                "active_company_id": str(ctx.company_id) if ctx.company_id else None,
                "companies": [
                    {"id": str(c.pk), "code": c.code, "name": c.trade_name or c.legal_name} for c in companies
                ],
                "roles": sorted(snapshot.role_codes),
                "permissions": permissions,
                "feature_flags": {}
                if restricted
                else flags.effective_flags(
                    user_id=user.pk,
                    role_codes=snapshot.role_codes,
                    company_id=ctx.company_id,
                    organization_id=user.organization_id,
                ),
                "mfa": {
                    "enrolled": device is not None,
                    "required": services._session_policy(user)["mfa_required"],
                    "verified_at": session.mfa_verified_at,
                },
                "session": {
                    "id": str(session.pk),
                    "client_type": session.client_type,
                    "restricted_reason": session.restricted_reason or None,
                    "idle_expires_at": session.idle_expires_at,
                    "absolute_expires_at": session.absolute_expires_at,
                },
            }
        )


class StepUpView(APIView):
    authz_authenticated_only = True

    @extend_schema(
        request=CodeSerializer,
        responses=inline_serializer("StepUp", {"mfa_verified_at": serializers.DateTimeField()}),
        tags=["auth"],
    )
    def post(self, request):
        data = CodeSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        verified_at = services.step_up(actor_for(request), request.auth, data.validated_data["code"])
        return Response({"mfa_verified_at": verified_at})


class PasswordChangeView(APIView):
    authz_authenticated_only = True
    authz_allow_restricted = True
    throttle_scope = "auth"

    @extend_schema(request=PasswordChangeSerializer, responses={204: None}, tags=["auth"])
    def post(self, request):
        data = PasswordChangeSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        services.change_password(
            actor_for(request),
            request.auth,
            data.validated_data["current_password"],
            data.validated_data["new_password"],
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class TOTPSetupView(APIView):
    authz_authenticated_only = True
    authz_allow_restricted = True

    @extend_schema(
        request=None,
        responses=inline_serializer(
            "TOTPSetup", {"secret": serializers.CharField(), "otpauth_uri": serializers.CharField()}
        ),
        tags=["auth"],
    )
    def post(self, request):
        return Response(services.begin_totp_enrollment(actor_for(request)))


class TOTPConfirmView(APIView):
    authz_authenticated_only = True
    authz_allow_restricted = True
    throttle_scope = "auth"

    @extend_schema(
        request=CodeSerializer,
        responses=inline_serializer(
            "RecoveryCodes", {"recovery_codes": serializers.ListField(child=serializers.CharField())}
        ),
        tags=["auth"],
    )
    def post(self, request):
        data = CodeSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        codes = services.confirm_totp_enrollment(actor_for(request), request.auth, data.validated_data["code"])
        return Response({"recovery_codes": codes})


class RecoveryCodesView(APIView):
    authz_authenticated_only = True

    @extend_schema(
        request=None,
        responses=inline_serializer(
            "RecoveryCodesRegenerated", {"recovery_codes": serializers.ListField(child=serializers.CharField())}
        ),
        tags=["auth"],
    )
    def post(self, request):
        return Response({"recovery_codes": services.regenerate_recovery_codes(actor_for(request))})


class OwnSessionsViewSet(mixins.ListModelMixin, mixins.DestroyModelMixin, ERPGenericViewSet):
    """The caller's own sessions (self-service)."""

    authz_authenticated_only = True
    serializer_class = SessionSerializer
    pagination_class = None

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return AuthSession.objects.none()
        return AuthSession.objects.filter(
            user=self.request.user, revoked_at__isnull=True, absolute_expires_at__gt=timezone.now()
        ).order_by("-last_seen_at")

    def perform_destroy(self, instance):
        services.revoke_session(instance, "user_revoked", self.actor)


class UserViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    authz_resource = "identity.user"
    authz_actions = {
        "activate": "manage",
        "deactivate": "manage",
        "unlock": "manage",
        "reset_mfa": "manage",
        "revoke_sessions": "manage",
        "sessions": "identity.auth_session.read",
    }
    queryset = User.objects.select_related("mfa_device").order_by("email")
    serializer_class = UserSerializer
    filterset_fields = ["is_active", "default_company", "mfa_enforced"]
    search_fields = ["email", "full_name", "phone"]
    ordering_fields = ["email", "full_name", "created_at", "last_login"]

    @extend_schema(request=UserCreateSerializer, responses={201: UserSerializer}, parameters=[idempotency_header()])
    @idempotent()
    def create(self, request):
        data = UserCreateSerializer(data=request.data, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        v = data.validated_data
        org = request.user.organization
        company = v.get("default_company")
        pdp.require(
            self.actor,
            "identity.user.create",
            pdp.Resource.ref(
                "identity.user",
                scope_fields={"organization": "organization_id", "company": "default_company_id"},
                organization_id=org.pk if org else None,
                default_company_id=company.pk if company else None,
            ),
        )
        user = services.create_user(
            self.actor,
            email=v["email"],
            full_name=v["full_name"],
            temporary_password=v["temporary_password"],
            organization=org,
            default_company=company,
            phone=v["phone"],
            mfa_enforced=v["mfa_enforced"],
        )
        return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)

    @extend_schema(request=UserUpdateSerializer, responses=UserSerializer)
    def partial_update(self, request, pk=None):
        user = self.get_object()
        data = UserUpdateSerializer(data=request.data, partial=True, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        user = services.update_user(self.actor, user, data.validated_data)
        return Response(UserSerializer(user).data)

    def _admin_action(self, func, *args):
        user = self.get_object()
        result = func(self.actor, user, *args)
        return Response(UserSerializer(result if isinstance(result, User) else User.objects.get(pk=user.pk)).data)

    @extend_schema(request=None, responses=UserSerializer)
    @action(detail=True, methods=["post"])
    def deactivate(self, request, pk=None):
        return self._admin_action(services.set_user_active, False)

    @extend_schema(request=None, responses=UserSerializer)
    @action(detail=True, methods=["post"])
    def activate(self, request, pk=None):
        return self._admin_action(services.set_user_active, True)

    @extend_schema(request=None, responses=UserSerializer)
    @action(detail=True, methods=["post"])
    def unlock(self, request, pk=None):
        return self._admin_action(services.unlock_user)

    @extend_schema(request=None, responses=UserSerializer)
    @action(detail=True, methods=["post"], url_path="reset-mfa")
    def reset_mfa(self, request, pk=None):
        return self._admin_action(services.reset_mfa)

    @extend_schema(request=None, responses=inline_serializer("RevokedCount", {"revoked": serializers.IntegerField()}))
    @action(detail=True, methods=["post"], url_path="revoke-sessions")
    def revoke_sessions(self, request, pk=None):
        user = self.get_object()
        return Response({"revoked": services.revoke_user_sessions(user, "admin_revoked", ctx=self.actor)})

    @extend_schema(responses=SessionSerializer(many=True))
    @action(detail=True, methods=["get"], pagination_class=None)
    def sessions(self, request, pk=None):
        user = self.get_object()
        qs = AuthSession.objects.filter(
            user=user, revoked_at__isnull=True, absolute_expires_at__gt=timezone.now()
        ).order_by("-last_seen_at")
        return Response(SessionSerializer(qs, many=True, context={"request": request}).data)

    def get_object(self):
        try:
            return super().get_object()
        except ValueError as exc:
            raise NotFound() from exc


class DirectoryView(APIView):
    """Colleague lookup for pickers (delegation, mentions): name and email only, search required."""

    authz_authenticated_only = True  # per-user rate limit applies (typeahead), not the strict login limit

    @extend_schema(
        parameters=[OpenApiParameter("search", str, required=True, description="At least 2 characters")],
        responses=inline_serializer(
            "DirectoryEntry",
            {"id": serializers.UUIDField(), "full_name": serializers.CharField(), "email": serializers.EmailField()},
            many=True,
        ),
        tags=["identity"],
    )
    def get(self, request):
        term = request.query_params.get("search", "").strip()
        if len(term) < 2:
            return Response([])
        users = (
            User.objects.filter(organization_id=request.user.organization_id, is_active=True)
            .filter(Q(full_name__icontains=term) | Q(email__icontains=term))
            .exclude(pk=request.user.pk)
            .order_by("full_name")[:20]
        )
        return Response([{"id": str(u.pk), "full_name": u.full_name, "email": u.email} for u in users])
