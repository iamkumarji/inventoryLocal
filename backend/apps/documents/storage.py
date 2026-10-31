"""Object storage abstraction for document content (ARCHITECTURE §5.8).

Backends:
- `S3Storage`: S3 / MinIO through boto3 (optional dependency, imported lazily) with presigned URLs.
- `LocalFileStorage`: files under a local root, for development and tests. Download URLs point to an
  authenticated Django view and carry an HMAC-signed, expiring token bound to the requesting user.

Configured by `settings.DOCUMENTS_STORAGE = {"BACKEND": "<dotted path>", "OPTIONS": {...}}`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from abc import ABC, abstractmethod
from functools import lru_cache
from pathlib import Path
from typing import BinaryIO
from urllib.parse import quote

from django.conf import settings
from django.core.signals import setting_changed
from django.dispatch import receiver
from django.urls import reverse
from django.utils.crypto import salted_hmac
from django.utils.module_loading import import_string

MAX_URL_TTL_SECONDS = 300  # presigned URLs live at most 5 minutes
KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9/_\-.]{0,299}$")
CHUNK = 1024 * 1024


class StorageError(Exception):
    pass


class InvalidToken(StorageError):
    pass


def url_ttl() -> int:
    return max(1, min(int(getattr(settings, "DOCUMENTS_URL_TTL_SECONDS", MAX_URL_TTL_SECONDS)), MAX_URL_TTL_SECONDS))


def _check_key(key: str) -> str:
    if not KEY_RE.match(key) or ".." in key.split("/") or "//" in key:
        raise StorageError("invalid object key")
    return key


def content_disposition(filename: str) -> str:
    ascii_name = filename.encode("ascii", "ignore").decode().replace('"', "") or "download"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


class StorageBackend(ABC):
    @abstractmethod
    def put(self, key: str, fileobj: BinaryIO, *, content_type: str, size: int) -> None:
        """Store a new object. Implementations must never overwrite an existing key."""

    @abstractmethod
    def presigned_get(
        self, key: str, *, filename: str, content_type: str, expires_in: int, subject_id: str | None = None
    ) -> str:
        """Short-lived download URL. `subject_id` binds the URL to a user where the backend supports it."""

    @abstractmethod
    def presigned_put(self, key: str, *, content_type: str, size: int, expires_in: int) -> dict:
        """Short-lived direct-upload instructions: {"method", "url", "headers"}."""

    @abstractmethod
    def delete(self, key: str) -> None:
        """Remove an object (idempotent)."""


# --- Local filesystem -----------------------------------------------------------------------------


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class LocalFileStorage(StorageBackend):
    TOKEN_SALT = "apps.documents.storage.download"

    def __init__(self, root: str | os.PathLike | None = None, signing_key: str | None = None):
        self.root = Path(root or Path(settings.BASE_DIR) / "var" / "documents").resolve()
        self.signing_key = signing_key or getattr(settings, "DOCUMENTS_SIGNING_KEY", None) or settings.SECRET_KEY

    def path(self, key: str) -> Path:
        path = (self.root / _check_key(key)).resolve()
        if self.root not in path.parents:
            raise StorageError("object key escapes the storage root")
        return path

    def put(self, key: str, fileobj: BinaryIO, *, content_type: str, size: int) -> None:
        path = self.path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        fileobj.seek(0)
        with open(path, "xb") as out:  # "x": fail rather than overwrite
            while chunk := fileobj.read(CHUNK):
                out.write(chunk)

    def open(self, key: str) -> BinaryIO:
        return open(self.path(key), "rb")  # caller (FileResponse) closes it

    def delete(self, key: str) -> None:
        try:
            self.path(key).unlink()
        except FileNotFoundError:
            pass

    # Tokens: base64url(json payload) "." hex HMAC-SHA256 over the encoded payload.
    def _signature(self, encoded: str) -> str:
        return salted_hmac(self.TOKEN_SALT, encoded, secret=self.signing_key, algorithm="sha256").hexdigest()

    def make_token(self, key: str, *, subject_id: str | None, expires_in: int) -> str:
        payload = {"k": _check_key(key), "u": subject_id, "exp": int(time.time()) + expires_in}
        encoded = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
        return f"{encoded}.{self._signature(encoded)}"

    def read_token(self, token: str, *, now: float | None = None) -> dict:
        try:
            encoded, signature = token.split(".", 1)
        except (AttributeError, ValueError):
            raise InvalidToken("malformed") from None
        if not hmac.compare_digest(signature, self._signature(encoded)):
            raise InvalidToken("bad_signature")
        try:
            payload = json.loads(_unb64(encoded))
        except (ValueError, TypeError):
            raise InvalidToken("malformed") from None
        if not isinstance(payload, dict) or not isinstance(payload.get("exp"), int) or "k" not in payload:
            raise InvalidToken("malformed")
        if payload["exp"] < (now if now is not None else time.time()):
            raise InvalidToken("expired")
        return payload

    def presigned_get(
        self, key: str, *, filename: str, content_type: str, expires_in: int, subject_id: str | None = None
    ) -> str:
        token = self.make_token(key, subject_id=subject_id, expires_in=min(expires_in, MAX_URL_TTL_SECONDS))
        return reverse("documents-file", kwargs={"token": token})

    def presigned_put(self, key: str, *, content_type: str, size: int, expires_in: int) -> dict:
        raise NotImplementedError("The local backend accepts multipart uploads through the API directly.")


# --- S3 / MinIO -----------------------------------------------------------------------------------


class S3Storage(StorageBackend):
    """S3-compatible storage. Requires `boto3` (not a hard dependency of the project)."""

    def __init__(
        self,
        bucket: str,
        endpoint_url: str | None = None,
        region: str | None = None,
        access_key: str | None = None,
        secret_key: str | None = None,
        prefix: str = "",
        addressing_style: str = "path",
        public_endpoint_url: str | None = None,
    ):
        try:
            import boto3
            from botocore.config import Config
        except ImportError as exc:  # pragma: no cover - depends on the deployment
            raise StorageError("S3Storage requires the 'boto3' package") from exc
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            region_name=region,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(signature_version="s3v4", s3={"addressing_style": addressing_style}),
        )
        # Links handed to browsers are signed for the public address (the signature covers the host);
        # the server itself talks to the internal endpoint.
        self.signer = (
            boto3.client(
                "s3",
                endpoint_url=public_endpoint_url,
                region_name=region,
                aws_access_key_id=access_key,
                aws_secret_access_key=secret_key,
                config=Config(signature_version="s3v4", s3={"addressing_style": addressing_style}),
            )
            if public_endpoint_url
            else self.client
        )

    def _key(self, key: str) -> str:
        key = _check_key(key)
        return f"{self.prefix}/{key}" if self.prefix else key

    def put(self, key: str, fileobj: BinaryIO, *, content_type: str, size: int) -> None:
        fileobj.seek(0)
        self.client.put_object(
            Bucket=self.bucket,
            Key=self._key(key),
            Body=fileobj,
            ContentType=content_type,
            ContentLength=size,
            IfNoneMatch="*",  # never overwrite (S3 conditional writes; MinIO supports If-None-Match)
        )

    def presigned_get(
        self, key: str, *, filename: str, content_type: str, expires_in: int, subject_id: str | None = None
    ) -> str:
        return self.signer.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": self.bucket,
                "Key": self._key(key),
                "ResponseContentDisposition": content_disposition(filename),
                "ResponseContentType": content_type,
            },
            ExpiresIn=min(expires_in, MAX_URL_TTL_SECONDS),
        )

    def presigned_put(self, key: str, *, content_type: str, size: int, expires_in: int) -> dict:
        url = self.signer.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": self._key(key), "ContentType": content_type, "ContentLength": size},
            ExpiresIn=min(expires_in, MAX_URL_TTL_SECONDS),
        )
        return {"method": "PUT", "url": url, "headers": {"Content-Type": content_type}}

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=self._key(key))


# --- Factory --------------------------------------------------------------------------------------


def _config() -> dict:
    return getattr(settings, "DOCUMENTS_STORAGE", None) or {"BACKEND": "apps.documents.storage.LocalFileStorage"}


@lru_cache(maxsize=4)
def _build(config_json: str) -> StorageBackend:
    config = json.loads(config_json)
    return import_string(config["BACKEND"])(**config.get("OPTIONS", {}))


def get_storage() -> StorageBackend:
    return _build(json.dumps(_config(), sort_keys=True, default=str))


@receiver(setting_changed)
def _reset_storage(*, setting, **kwargs):
    if setting in {"DOCUMENTS_STORAGE", "DOCUMENTS_SIGNING_KEY", "SECRET_KEY"}:
        _build.cache_clear()


def sha256_of(fileobj: BinaryIO) -> str:
    digest = hashlib.sha256()
    fileobj.seek(0)
    while chunk := fileobj.read(CHUNK):
        digest.update(chunk)
    fileobj.seek(0)
    return digest.hexdigest()
