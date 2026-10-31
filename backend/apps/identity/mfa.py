"""TOTP (RFC 6238) with replay protection, and recovery codes."""

import hmac
import secrets
import time

import pyotp
from django.conf import settings

from apps.core.crypto import decrypt_str, encrypt_str, keyed_hash

STEP_SECONDS = 30
VALID_WINDOW = 1  # accept one step of clock drift either side
_RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_secret() -> str:
    return pyotp.random_base32(length=32)


def encrypt_secret(secret: str) -> str:
    return encrypt_str(secret)


def provisioning_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=settings.ERP["TOTP_ISSUER"])


def match_totp_step(secret_encrypted: str, code: str, last_used_step: int, now: float | None = None) -> int | None:
    """Return the matched time step if `code` is valid and newer than `last_used_step`."""
    code = (code or "").strip().replace(" ", "")
    if not code.isdigit() or len(code) != 6:
        return None
    totp = pyotp.TOTP(decrypt_str(secret_encrypted))
    current = int((now if now is not None else time.time()) // STEP_SECONDS)
    for step in range(current - VALID_WINDOW, current + VALID_WINDOW + 1):
        if step <= last_used_step:
            continue
        if hmac.compare_digest(totp.at(step * STEP_SECONDS), code):
            return step
    return None


def generate_recovery_codes(count: int) -> list[str]:
    return [
        "-".join("".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(5)) for _ in range(2)) for _ in range(count)
    ]


def normalize_recovery_code(code: str) -> str:
    raw = (code or "").strip().upper().replace(" ", "").replace("-", "")
    return f"{raw[:5]}-{raw[5:]}" if len(raw) == 10 else raw


def hash_recovery_code(code: str) -> str:
    return keyed_hash(normalize_recovery_code(code), "mfa-recovery")
