from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.db import models
from django.db.models.functions import Lower

from apps.core.models import AuthzResourceMixin, TimeStampedModel, UUIDModel


class UserManager(BaseUserManager):
    use_in_migrations = True

    def create_user(self, email: str, password: str | None = None, **extra):
        if not email:
            raise ValueError("Email is required")
        user = self.model(email=self.normalize_email(email).lower(), **extra)
        if password:
            user.set_password(password)
        else:
            user.set_unusable_password()
        user.save(using=self._db)
        return user

    def create_superuser(self, email: str, password: str | None = None, **extra):
        """Break-glass account. Created only via the management command, never via API."""
        extra.update(is_staff=True, is_superuser=True, mfa_enforced=True)
        return self.create_user(email, password, **extra)


class User(AuthzResourceMixin, AbstractBaseUser, TimeStampedModel):
    organization = models.ForeignKey(
        "organization.Organization", null=True, blank=True, on_delete=models.PROTECT, related_name="users"
    )
    email = models.EmailField(max_length=254, unique=True)  # stored lower-case; plus case-insensitive constraint
    full_name = models.CharField(max_length=200)
    phone = models.CharField(max_length=30, blank=True)
    default_company = models.ForeignKey(
        "organization.Company", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    employee_id = models.UUIDField(null=True, blank=True)  # FK to hr.Employee in Phase 6
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    is_superuser = models.BooleanField(default=False)
    mfa_enforced = models.BooleanField(default=False)
    failed_login_count = models.PositiveIntegerField(default=0)
    locked_until = models.DateTimeField(null=True, blank=True)
    password_changed_at = models.DateTimeField(null=True, blank=True)
    must_change_password = models.BooleanField(default=False)

    objects = UserManager()

    USERNAME_FIELD = "email"
    EMAIL_FIELD = "email"
    REQUIRED_FIELDS = ["full_name"]

    authz_resource_type = "identity.user"
    authz_scope_fields = {"organization": "organization_id", "company": "default_company_id"}

    class Meta:
        db_table = "users"
        constraints = [models.UniqueConstraint(Lower("email"), name="uq_user_email_lower")]

    def __str__(self) -> str:
        return self.email

    # Django admin is not used; these exist for framework compatibility only.
    def has_perm(self, perm, obj=None) -> bool:
        return False

    def has_module_perms(self, app_label) -> bool:
        return False


class AuthSession(UUIDModel):
    class ClientType(models.TextChoices):
        WEB = "web"
        MOBILE = "mobile"
        API = "api"

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="auth_sessions")
    token_hash = models.CharField(max_length=64, unique=True)
    client_type = models.CharField(max_length=10, choices=ClientType.choices)
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=300, blank=True)
    device_id = models.CharField(max_length=100, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField()
    idle_expires_at = models.DateTimeField()
    absolute_expires_at = models.DateTimeField()
    mfa_verified_at = models.DateTimeField(null=True, blank=True)
    # Restricted sessions may only complete mandatory MFA enrolment or a password change.
    restricted_reason = models.CharField(max_length=40, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_reason = models.CharField(max_length=60, blank=True)

    class Meta:
        db_table = "auth_sessions"
        indexes = [models.Index(fields=["user", "revoked_at"], name="ix_auth_session_user")]


class AuthChallenge(UUIDModel):
    class Purpose(models.TextChoices):
        MFA_LOGIN = "mfa_login"

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="+")
    challenge_hash = models.CharField(max_length=64, unique=True)
    purpose = models.CharField(max_length=20, choices=Purpose.choices)
    client_type = models.CharField(max_length=10)
    device_id = models.CharField(max_length=100, blank=True)
    expires_at = models.DateTimeField()
    attempts = models.PositiveSmallIntegerField(default=0)
    consumed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "auth_challenges"


class MFADevice(TimeStampedModel):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="mfa_device")
    secret_encrypted = models.TextField()
    confirmed_at = models.DateTimeField(null=True, blank=True)
    last_used_step = models.BigIntegerField(default=0)

    class Meta:
        db_table = "mfa_devices"


class MFARecoveryCode(UUIDModel):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="recovery_codes")
    code_hash = models.CharField(max_length=64)
    used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "mfa_recovery_codes"
        constraints = [models.UniqueConstraint(fields=["user", "code_hash"], name="uq_recovery_code")]


class PasswordHistory(UUIDModel):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="password_history")
    password_hash = models.CharField(max_length=256)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "password_history"
        ordering = ["-created_at"]
