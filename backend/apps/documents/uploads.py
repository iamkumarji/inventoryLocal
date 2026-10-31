"""Upload validation: allow-listed types (by extension and content sniffing), size limit, SHA-256.

The stored content type is decided by the server from the file itself; the client's declared type
must agree with it but is never trusted on its own.
"""

from __future__ import annotations

import hashlib
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import PurePath

from django.conf import settings
from rest_framework.exceptions import ValidationError

DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

# extension -> canonical content type
EXTENSIONS = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".xlsx": XLSX,
    ".docx": DOCX,
    ".csv": "text/csv",
    ".txt": "text/plain",
}
# Declared types browsers commonly send for the canonical ones.
ALIASES = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "application/csv": "text/csv",
    "text/x-csv": "text/csv",
    "application/vnd.ms-excel": "text/csv",  # Windows browsers label .csv this way
}
GENERIC_DECLARED = {"", "application/octet-stream", "binary/octet-stream"}
ALLOWED_TYPES = frozenset(EXTENSIONS.values())


@dataclass(frozen=True)
class ValidatedUpload:
    filename: str
    content_type: str
    size: int
    sha256: str


def max_upload_bytes() -> int:
    return int(getattr(settings, "DOCUMENTS_MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES))


def clean_filename(name: str) -> str:
    base = PurePath((name or "").replace("\\", "/")).name
    base = "".join(ch for ch in unicodedata.normalize("NFC", base) if unicodedata.category(ch)[0] != "C")
    base = base.strip().strip(".")
    if not base:
        raise ValidationError({"file": ["The file needs a name."]}, code="invalid_filename")
    if len(base) > 200:
        stem, dot, ext = base.rpartition(".")
        base = (stem[: 200 - len(ext) - 1] + dot + ext) if dot and len(ext) <= 10 else base[:200]
    return base


def _reject(message: str, code: str):
    raise ValidationError({"file": [message]}, code=code)


def _is_ooxml(fileobj, marker: str) -> bool:
    fileobj.seek(0)
    try:
        with zipfile.ZipFile(fileobj) as archive:
            names = set(archive.namelist())
    except (zipfile.BadZipFile, OSError, ValueError):
        return False
    finally:
        fileobj.seek(0)
    return "[Content_Types].xml" in names and marker in names


def _sniff(content_type: str, head: bytes, fileobj) -> bool:
    if content_type == "application/pdf":
        return head.startswith(b"%PDF-")
    if content_type == "image/png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/jpeg":
        return head.startswith(b"\xff\xd8\xff")
    if content_type == "image/webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if content_type == XLSX:
        return head.startswith(b"PK\x03\x04") and _is_ooxml(fileobj, "xl/workbook.xml")
    if content_type == DOCX:
        return head.startswith(b"PK\x03\x04") and _is_ooxml(fileobj, "word/document.xml")
    return True  # text types are checked while hashing


def validate(upload, declared_type: str | None = None) -> ValidatedUpload:
    """Validate an uploaded file (Django UploadedFile or any seekable binary file with `.name`)."""
    filename = clean_filename(getattr(upload, "name", ""))
    content_type = EXTENSIONS.get(PurePath(filename).suffix.lower())
    if content_type is None:
        _reject("This file type is not allowed. Use PDF, PNG, JPEG, WEBP, XLSX, DOCX, CSV or TXT.", "unsupported_type")
    declared = (declared_type or getattr(upload, "content_type", "") or "").split(";")[0].strip().lower()
    if declared not in GENERIC_DECLARED and ALIASES.get(declared, declared) != content_type:
        _reject("The file's type does not match its extension.", "content_type_mismatch")
    limit = max_upload_bytes()
    size = getattr(upload, "size", None)
    if size is not None and size > limit:
        _reject(f"The file is larger than {limit // (1024 * 1024)} MB.", "file_too_large")

    upload.seek(0)
    head = upload.read(4096)
    upload.seek(0)
    if not head:
        _reject("The file is empty.", "empty_file")
    if not _sniff(content_type, head, upload):
        _reject("The file's content does not match its type.", "content_mismatch")

    is_text = content_type.startswith("text/")
    digest, total = hashlib.sha256(), 0
    decoder = None
    if is_text:
        import codecs

        decoder = codecs.getincrementaldecoder("utf-8")()
    while chunk := upload.read(1024 * 1024):
        total += len(chunk)
        if total > limit:
            _reject(f"The file is larger than {limit // (1024 * 1024)} MB.", "file_too_large")
        if decoder is not None:
            if b"\x00" in chunk:
                _reject("Text files must not contain binary data.", "content_mismatch")
            try:
                decoder.decode(chunk)
            except UnicodeDecodeError:
                _reject("Text files must be UTF-8 encoded.", "content_mismatch")
        digest.update(chunk)
    if decoder is not None:
        try:
            decoder.decode(b"", final=True)
        except UnicodeDecodeError:
            _reject("Text files must be UTF-8 encoded.", "content_mismatch")
    upload.seek(0)
    return ValidatedUpload(filename=filename, content_type=content_type, size=total, sha256=digest.hexdigest())
