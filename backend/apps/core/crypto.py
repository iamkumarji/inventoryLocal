"""Field-level encryption for secrets at rest (MFA seeds, bank accounts, salary-sensitive data)."""

import hashlib
import hmac
from functools import lru_cache

from cryptography.fernet import Fernet, MultiFernet
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured


@lru_cache(maxsize=1)
def _fernet() -> MultiFernet:
    keys = settings.FIELD_ENCRYPTION_KEYS
    if not keys:
        raise ImproperlyConfigured("FIELD_ENCRYPTION_KEYS is not configured")
    return MultiFernet([Fernet(k.encode() if isinstance(k, str) else k) for k in keys])


def encrypt_str(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_str(token: str) -> str:
    return _fernet().decrypt(token.encode()).decode()


def rotate_token(token: str) -> str:
    """Re-encrypt under the first (current) key; readable tokens under older keys stay readable."""
    return _fernet().rotate(token.encode()).decode()


def reset_keys() -> None:
    """Forget cached keys (after settings change, e.g. in tests or a key rollover)."""
    _fernet.cache_clear()


# Every column holding encrypt_str() output: (app_label.Model, field). Key rotation and integrity
# checks walk this list, so a new encrypted column must be added here.
ENCRYPTED_COLUMNS = [
    ("identity.MFADevice", "secret_encrypted"),
    ("partners.PartnerBankAccount", "account_number_encrypted"),
    ("hr.Employee", "pan_encrypted"),
    ("hr.Employee", "bank_account_encrypted"),
    ("hr.Employee", "aadhaar_last4_encrypted"),
]


def keyed_hash(value: str, purpose: str) -> str:
    """HMAC-SHA256 keyed with SECRET_KEY, for lookup hashes of high-entropy secrets."""
    key = hashlib.sha256(f"{purpose}:{settings.SECRET_KEY}".encode()).digest()
    return hmac.new(key, value.encode(), hashlib.sha256).hexdigest()


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
