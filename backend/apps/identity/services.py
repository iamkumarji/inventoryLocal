"""Identity services: login, MFA, sessions, password management, user administration."""

from __future__ import annotations

import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import F
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.audit.models import AuditEvent
from apps.core.context import ActorContext
from apps.core.crypto import sha256_hex
from apps.core.exceptions import (
    AccountLocked,
    AuthenticationFailedError,
    BusinessRuleViolation,
    MFARequired,
    VersionConflict,
)

from . import mfa
from .models import AuthChallenge, AuthSession, MFADevice, MFARecoveryCode, PasswordHistory, User

_DUMMY_HASH = make_password("timing-equaliser-not-a-real-password")


# --- Session policy hook -------------------------------------------------------
# The authorization module registers a provider (in AppConfig.ready) returning
# role-derived policy: {"mfa_required": bool, "max_session_minutes": int | None}.
# This keeps identity independent of authorization at import time.
_session_policy_provider: Callable[[User], dict] | None = None


def register_session_policy_provider(provider: Callable[[User], dict]) -> None:
    global _session_policy_provider
    _session_policy_provider = provider


def _session_policy(user: User) -> dict:
    policy = {"mfa_required": False, "max_session_minutes": None}
    if _session_policy_provider is not None:
        policy.update(_session_policy_provider(user))
    organization = user.organization if user.organization_id else None
    policy["mfa_required"] = (
        policy["mfa_required"]
        or user.mfa_enforced
        or user.is_superuser
        or user.is_platform_operator
        or bool(organization and organization.require_mfa_for_all)
    )
    return policy


@dataclass
class ClientInfo:
    client_type: str = AuthSession.ClientType.WEB
    ip: str | None = None
    user_agent: str = ""
    device_id: str = ""
    request_id: str = ""

    def ctx(self, user: User | None = None) -> ActorContext:
        kwargs: dict[str, Any] = {
            "user": user,
            "ip": self.ip,
            "user_agent": self.user_agent,
            "client_type": self.client_type,
        }
        if self.request_id:
            kwargs["request_id"] = self.request_id
        return ActorContext(**kwargs)


@dataclass
class LoginResult:
    status: str  # authenticated | mfa_required | mfa_enrollment_required | password_change_required
    user: User
    session: AuthSession | None = None
    token: str | None = None
    challenge_token: str | None = None


# --- Sessions -------------------------------------------------------------------


def _timeouts(client_type: str) -> tuple[timedelta, timedelta]:
    cfg = settings.ERP
    if client_type == AuthSession.ClientType.MOBILE:
        return timedelta(minutes=cfg["MOBILE_SESSION_IDLE_MINUTES"]), timedelta(
            hours=cfg["MOBILE_SESSION_ABSOLUTE_HOURS"]
        )
    return timedelta(minutes=cfg["SESSION_IDLE_MINUTES"]), timedelta(hours=cfg["SESSION_ABSOLUTE_HOURS"])


def create_session(
    user: User, client: ClientInfo, *, mfa_verified: bool, restricted_reason: str = ""
) -> tuple[AuthSession, str]:
    token = secrets.token_urlsafe(32)
    now = timezone.now()
    idle, absolute = _timeouts(client.client_type)
    max_minutes = _session_policy(user)["max_session_minutes"]
    if max_minutes:
        absolute = min(absolute, timedelta(minutes=max_minutes))
    session = AuthSession.objects.create(
        user=user,
        token_hash=sha256_hex(token),
        client_type=client.client_type,
        ip=client.ip,
        user_agent=client.user_agent[:300],
        device_id=client.device_id[:100],
        last_seen_at=now,
        idle_expires_at=min(now + idle, now + absolute),
        absolute_expires_at=now + absolute,
        mfa_verified_at=now if mfa_verified else None,
        restricted_reason=restricted_reason,
    )
    return session, token


def authenticate_token(raw_token: str) -> AuthSession | None:
    if not raw_token or len(raw_token) > 200:
        return None
    session = AuthSession.objects.select_related("user__organization").filter(token_hash=sha256_hex(raw_token)).first()
    if session is None or session.revoked_at is not None:
        return None
    now = timezone.now()
    if now >= session.idle_expires_at or now >= session.absolute_expires_at:
        return None
    if not session.user.is_active or not _organization_active(session.user):
        return None
    if (now - session.last_seen_at).total_seconds() >= settings.ERP["SESSION_TOUCH_SECONDS"]:
        idle, _ = _timeouts(session.client_type)
        session.last_seen_at = now
        session.idle_expires_at = min(now + idle, session.absolute_expires_at)
        AuthSession.objects.filter(pk=session.pk).update(
            last_seen_at=session.last_seen_at, idle_expires_at=session.idle_expires_at
        )
    return session


def revoke_session(session: AuthSession, reason: str, ctx: ActorContext | None = None) -> None:
    if session.revoked_at is None:
        session.revoked_at = timezone.now()
        session.revoked_reason = reason[:60]
        session.save(update_fields=["revoked_at", "revoked_reason"])
        audit.record(
            "auth.session.revoked",
            ctx=ctx,
            resource_type="identity.auth_session",
            resource_id=session.pk,
            summary=reason,
            actor_id=None if ctx and ctx.user else session.user_id,
        )


def revoke_user_sessions(user: User, reason: str, *, except_session_id=None, ctx: ActorContext | None = None) -> int:
    qs = AuthSession.objects.filter(user=user, revoked_at__isnull=True)
    if except_session_id:
        qs = qs.exclude(pk=except_session_id)
    count = qs.update(revoked_at=timezone.now(), revoked_reason=reason[:60])
    if count:
        audit.record(
            "auth.sessions.revoked_all",
            ctx=ctx,
            resource_type="identity.user",
            resource_id=user.pk,
            summary=f"{count} session(s): {reason}",
            changes={"count": count},
        )
    return count


# --- Login ------------------------------------------------------------------------


def _record_login_failure(email: str, client: ClientInfo, reason: str, user: User | None = None) -> None:
    audit.record(
        "auth.login.failure",
        ctx=client.ctx(),
        resource_type="identity.user",
        resource_id=user.pk if user else "",
        actor_id=user.pk if user else None,
        actor_label=email[:254],
        organization_id=user.organization_id if user else None,
        summary=reason,
        outcome=AuditEvent.Outcome.FAILURE,
    )


def _organization_active(user) -> bool:
    """Users of a suspended organization can't sign in or use existing sessions."""
    return user.organization_id is None or user.organization.is_active


def login(email: str, password: str, client: ClientInfo) -> LoginResult:
    email = (email or "").strip().lower()
    user = User.objects.filter(email__iexact=email).first()
    if user is None:
        check_password(password, _DUMMY_HASH)  # equalise timing for unknown accounts
        _record_login_failure(email, client, "unknown_account")
        raise AuthenticationFailedError()
    now = timezone.now()
    if user.locked_until and user.locked_until > now:
        _record_login_failure(email, client, "locked", user)
        raise AccountLocked()
    if not user.is_active or not user.check_password(password) or not _organization_active(user):
        _register_failed_attempt(user)
        _record_login_failure(email, client, "inactive" if not user.is_active else "bad_password", user)
        raise AuthenticationFailedError()

    User.objects.filter(pk=user.pk).update(failed_login_count=0, locked_until=None, last_login=now)
    user.failed_login_count, user.locked_until, user.last_login = 0, None, now

    device = MFADevice.objects.filter(user=user, confirmed_at__isnull=False).first()
    if device is not None:
        token = secrets.token_urlsafe(32)
        AuthChallenge.objects.create(
            user=user,
            challenge_hash=sha256_hex(token),
            purpose=AuthChallenge.Purpose.MFA_LOGIN,
            client_type=client.client_type,
            device_id=client.device_id[:100],
            expires_at=now + timedelta(minutes=settings.ERP["MFA_CHALLENGE_MINUTES"]),
        )
        audit.record(
            "auth.login.password_ok",
            ctx=client.ctx(user),
            resource_type="identity.user",
            resource_id=user.pk,
            summary="MFA challenge issued",
        )
        return LoginResult("mfa_required", user, challenge_token=token)

    restricted = ""
    status = "authenticated"
    if _session_policy(user)["mfa_required"]:
        restricted, status = "mfa_enrollment", "mfa_enrollment_required"
    elif user.must_change_password:
        restricted, status = "password_change", "password_change_required"
    session, token = create_session(user, client, mfa_verified=False, restricted_reason=restricted)
    audit.record(
        "auth.login.success",
        ctx=client.ctx(user),
        resource_type="identity.auth_session",
        resource_id=session.pk,
        summary=status,
    )
    return LoginResult(status, user, session=session, token=token)


def _register_failed_attempt(user: User) -> None:
    threshold = settings.ERP["LOCKOUT_THRESHOLD"]
    User.objects.filter(pk=user.pk).update(failed_login_count=F("failed_login_count") + 1)
    user.refresh_from_db(fields=["failed_login_count"])
    if user.failed_login_count >= threshold:
        locked_until = timezone.now() + timedelta(minutes=settings.ERP["LOCKOUT_MINUTES"])
        User.objects.filter(pk=user.pk).update(locked_until=locked_until, failed_login_count=0)
        audit.record(
            "auth.account.locked",
            resource_type="identity.user",
            resource_id=user.pk,
            actor_id=user.pk,
            organization_id=user.organization_id,
            summary=f"Locked after {threshold} failed attempts",
            outcome=AuditEvent.Outcome.FAILURE,
        )


def _verify_second_factor(user: User, code: str) -> str | None:
    """Return 'totp' or 'recovery_code' when valid, consuming what was used."""
    code = (code or "").strip()
    with transaction.atomic():
        device = MFADevice.objects.select_for_update().filter(user=user, confirmed_at__isnull=False).first()
        if device is None:
            return None
        step = mfa.match_totp_step(device.secret_encrypted, code, device.last_used_step)
        if step is not None:
            device.last_used_step = step
            device.save(update_fields=["last_used_step", "updated_at"])
            return "totp"
        recovery = (
            MFARecoveryCode.objects.select_for_update()
            .filter(user=user, code_hash=mfa.hash_recovery_code(code), used_at__isnull=True)
            .first()
        )
        if recovery is not None:
            recovery.used_at = timezone.now()
            recovery.save(update_fields=["used_at"])
            return "recovery_code"
    return None


def complete_mfa_login(challenge_token: str, code: str, client: ClientInfo) -> LoginResult:
    now = timezone.now()
    challenge = (
        AuthChallenge.objects.select_related("user")
        .filter(challenge_hash=sha256_hex(challenge_token or ""), purpose=AuthChallenge.Purpose.MFA_LOGIN)
        .first()
    )
    if challenge is None or challenge.consumed_at or challenge.expires_at <= now or not challenge.user.is_active:
        raise AuthenticationFailedError("MFA challenge is invalid or expired. Sign in again.")
    user = challenge.user
    method = _verify_second_factor(user, code)
    if method is None:
        challenge.attempts += 1
        if challenge.attempts >= settings.ERP["MFA_CHALLENGE_MAX_ATTEMPTS"]:
            challenge.consumed_at = now
        challenge.save(update_fields=["attempts", "consumed_at"])
        audit.record(
            "auth.mfa.failure",
            ctx=client.ctx(user),
            resource_type="identity.user",
            resource_id=user.pk,
            outcome=AuditEvent.Outcome.FAILURE,
            summary=f"attempt {challenge.attempts}",
        )
        raise AuthenticationFailedError("Invalid verification code.")
    challenge.consumed_at = now
    challenge.save(update_fields=["consumed_at"])
    restricted = "password_change" if user.must_change_password else ""
    session, token = create_session(user, client, mfa_verified=True, restricted_reason=restricted)
    audit.record(
        "auth.login.success",
        ctx=client.ctx(user),
        resource_type="identity.auth_session",
        resource_id=session.pk,
        summary=f"mfa:{method}",
    )
    return LoginResult(
        "password_change_required" if restricted else "authenticated", user, session=session, token=token
    )


# --- MFA enrolment and step-up -------------------------------------------------------


def begin_totp_enrollment(ctx: ActorContext) -> dict:
    user = ctx.user
    if MFADevice.objects.filter(user=user, confirmed_at__isnull=False).exists():
        raise BusinessRuleViolation(
            "MFA is already enrolled. Ask an administrator to reset it.", code="mfa_already_enrolled"
        )
    secret = mfa.new_secret()
    MFADevice.objects.update_or_create(
        user=user, defaults={"secret_encrypted": mfa.encrypt_secret(secret), "confirmed_at": None, "last_used_step": 0}
    )
    audit.record("auth.mfa.enrollment_started", ctx=ctx, resource_type="identity.user", resource_id=user.pk)
    return {"secret": secret, "otpauth_uri": mfa.provisioning_uri(secret, user.email)}


@transaction.atomic
def confirm_totp_enrollment(ctx: ActorContext, session: AuthSession, code: str) -> list[str]:
    user = ctx.user
    device = MFADevice.objects.select_for_update().filter(user=user, confirmed_at__isnull=True).first()
    if device is None:
        raise BusinessRuleViolation("No pending MFA enrolment.", code="mfa_not_pending")
    step = mfa.match_totp_step(device.secret_encrypted, code, device.last_used_step)
    if step is None:
        raise ValidationError({"code": ["Invalid verification code."]})
    now = timezone.now()
    device.confirmed_at, device.last_used_step = now, step
    device.save(update_fields=["confirmed_at", "last_used_step", "updated_at"])
    codes = _replace_recovery_codes(user)
    session.mfa_verified_at = now
    if session.restricted_reason == "mfa_enrollment":
        session.restricted_reason = "password_change" if user.must_change_password else ""
    session.save(update_fields=["mfa_verified_at", "restricted_reason"])
    audit.record("auth.mfa.enrolled", ctx=ctx, resource_type="identity.user", resource_id=user.pk)
    return codes


def _replace_recovery_codes(user: User) -> list[str]:
    MFARecoveryCode.objects.filter(user=user).delete()
    codes = mfa.generate_recovery_codes(settings.ERP["RECOVERY_CODE_COUNT"])
    MFARecoveryCode.objects.bulk_create(
        [MFARecoveryCode(user=user, code_hash=mfa.hash_recovery_code(c)) for c in codes]
    )
    return codes


@transaction.atomic
def regenerate_recovery_codes(ctx: ActorContext) -> list[str]:
    if not ctx.mfa_verified_within(settings.ERP["STEP_UP_MINUTES"]):
        raise MFARequired()
    if not MFADevice.objects.filter(user=ctx.user, confirmed_at__isnull=False).exists():
        raise BusinessRuleViolation("MFA is not enrolled.", code="mfa_not_enrolled")
    codes = _replace_recovery_codes(ctx.user)
    audit.record("auth.mfa.recovery_codes_regenerated", ctx=ctx, resource_type="identity.user", resource_id=ctx.user.pk)
    return codes


def step_up(ctx: ActorContext, session: AuthSession, code: str) -> datetime:
    method = _verify_second_factor(ctx.user, code)
    if method is None:
        audit.record(
            "auth.step_up.failure",
            ctx=ctx,
            resource_type="identity.auth_session",
            resource_id=session.pk,
            outcome=AuditEvent.Outcome.FAILURE,
        )
        raise AuthenticationFailedError("Invalid verification code.")
    session.mfa_verified_at = timezone.now()
    session.save(update_fields=["mfa_verified_at"])
    audit.record(
        "auth.step_up.success", ctx=ctx, resource_type="identity.auth_session", resource_id=session.pk, summary=method
    )
    return session.mfa_verified_at


# --- Passwords --------------------------------------------------------------------


def _validate_new_password(user: User, new_password: str) -> None:
    try:
        validate_password(new_password, user)
    except DjangoValidationError as exc:
        raise ValidationError({"new_password": list(exc.messages)}) from exc
    if user.check_password(new_password):
        raise ValidationError({"new_password": ["The new password must differ from the current one."]})
    for entry in PasswordHistory.objects.filter(user=user)[: settings.ERP["PASSWORD_HISTORY"]]:
        if check_password(new_password, entry.password_hash):
            raise ValidationError({"new_password": ["This password was used recently. Choose a different one."]})


def _set_password(user: User, new_password: str) -> None:
    if user.has_usable_password():
        PasswordHistory.objects.create(user=user, password_hash=user.password)
    user.set_password(new_password)
    user.password_changed_at = timezone.now()
    user.must_change_password = False
    user.save(update_fields=["password", "password_changed_at", "must_change_password", "updated_at"])


@transaction.atomic
def change_password(ctx: ActorContext, session: AuthSession, current_password: str, new_password: str) -> None:
    user = User.objects.select_for_update().get(pk=ctx.user.pk)
    if not user.check_password(current_password):
        raise ValidationError({"current_password": ["Current password is incorrect."]})
    _validate_new_password(user, new_password)
    _set_password(user, new_password)
    revoke_user_sessions(user, "password_changed", except_session_id=session.pk, ctx=ctx)
    if session.restricted_reason == "password_change":
        session.restricted_reason = ""
        session.save(update_fields=["restricted_reason"])
    audit.record("auth.password.changed", ctx=ctx, resource_type="identity.user", resource_id=user.pk)


# --- User administration (authorization enforced by the caller via the PDP) -----------

USER_AUDIT_FIELDS = ("email", "full_name", "phone", "default_company", "is_active", "mfa_enforced", "organization")


@transaction.atomic
def create_user(
    ctx: ActorContext,
    *,
    email: str,
    full_name: str,
    temporary_password: str,
    organization,
    default_company=None,
    phone: str = "",
    mfa_enforced: bool = False,
) -> User:
    email = email.strip().lower()
    if User.objects.filter(email__iexact=email).exists():
        raise ValidationError({"email": ["A user with this email already exists."]})
    user = User(
        email=email,
        full_name=full_name,
        phone=phone,
        organization=organization,
        default_company=default_company,
        mfa_enforced=mfa_enforced,
        must_change_password=True,
    )
    try:
        validate_password(temporary_password, user)
    except DjangoValidationError as exc:
        raise ValidationError({"temporary_password": list(exc.messages)}) from exc
    user.set_password(temporary_password)
    user.password_changed_at = timezone.now()
    user.save()
    audit.record(
        "identity.user.created",
        ctx=ctx,
        resource_type="identity.user",
        resource_id=user.pk,
        company_id=default_company.pk if default_company else None,
        changes={"after": audit.snapshot(user, USER_AUDIT_FIELDS)},
    )
    return user


@transaction.atomic
def update_user(ctx: ActorContext, user: User, data: dict, expected_version: int | None = None) -> User:
    user = User.objects.select_for_update().get(pk=user.pk)
    before = audit.snapshot(user, USER_AUDIT_FIELDS)
    for field in ("full_name", "phone", "default_company", "mfa_enforced"):
        if field in data:
            setattr(user, field, data[field])
    user.save()
    after = audit.snapshot(user, USER_AUDIT_FIELDS)
    changes = audit.diff(before, after)
    if changes:
        audit.record(
            "identity.user.updated", ctx=ctx, resource_type="identity.user", resource_id=user.pk, changes=changes
        )
    return user


@transaction.atomic
def set_user_active(ctx: ActorContext, user: User, active: bool) -> User:
    if user.pk == ctx.user_id and not active:
        raise BusinessRuleViolation("You cannot deactivate your own account.", code="self_deactivation")
    user.is_active = active
    user.save(update_fields=["is_active", "updated_at"])
    if not active:
        revoke_user_sessions(user, "deactivated", ctx=ctx)
    audit.record(
        "identity.user.activated" if active else "identity.user.deactivated",
        ctx=ctx,
        resource_type="identity.user",
        resource_id=user.pk,
    )
    return user


def unlock_user(ctx: ActorContext, user: User) -> User:
    User.objects.filter(pk=user.pk).update(locked_until=None, failed_login_count=0)
    user.refresh_from_db()
    audit.record("identity.user.unlocked", ctx=ctx, resource_type="identity.user", resource_id=user.pk)
    return user


def mfa_required_for(user: User) -> bool:
    return _session_policy(user)["mfa_required"]


@transaction.atomic
def disable_own_mfa(ctx: ActorContext, session: AuthSession, *, password: str, code: str) -> None:
    """A user turns off their own two-step sign-in, only where no rule requires it, proving both
    factors. Admins can still require it per user, per role or for the whole organization."""
    user = User.objects.select_for_update().get(pk=ctx.user_id)
    if mfa_required_for(user):
        raise BusinessRuleViolation(
            "Two-step sign-in is required for your account by your organization, a role or an administrator.",
            code="mfa_required_by_policy",
        )
    if not MFADevice.objects.filter(user=user, confirmed_at__isnull=False).exists():
        raise BusinessRuleViolation("Two-step sign-in isn't set up.", code="mfa_not_enrolled")
    if not user.check_password(password) or _verify_second_factor(user, code) is None:
        audit.record(
            "identity.mfa.disable_failed",
            ctx=ctx,
            resource_type="identity.user",
            resource_id=user.pk,
            outcome=AuditEvent.Outcome.FAILURE,
        )
        raise AuthenticationFailedError("Password or code is incorrect.")
    MFADevice.objects.filter(user=user).delete()
    MFARecoveryCode.objects.filter(user=user).delete()
    session.mfa_verified_at = None
    session.save(update_fields=["mfa_verified_at"])
    revoke_user_sessions(user, "mfa_disabled", except_session_id=session.pk, ctx=ctx)
    audit.record("identity.mfa.disabled_by_user", ctx=ctx, resource_type="identity.user", resource_id=user.pk)


@transaction.atomic
def reset_mfa(ctx: ActorContext, user: User) -> None:
    if user.pk == ctx.user_id:
        raise BusinessRuleViolation("You cannot reset your own MFA.", code="self_mfa_reset")
    MFADevice.objects.filter(user=user).delete()
    MFARecoveryCode.objects.filter(user=user).delete()
    revoke_user_sessions(user, "mfa_reset", ctx=ctx)
    audit.record("identity.user.mfa_reset", ctx=ctx, resource_type="identity.user", resource_id=user.pk)


def check_version(instance, expected: int | None) -> None:
    if expected is not None and getattr(instance, "version", None) != expected:
        raise VersionConflict()
