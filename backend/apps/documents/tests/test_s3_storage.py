"""S3Storage against an in-process S3 (moto). MinIO speaks the same API; a live MinIO run is part of
the deployment smoke test (docs/runbooks), not of the unit suite."""

import io
from urllib.parse import parse_qs, urlparse

import pytest

moto = pytest.importorskip("moto")
from botocore.exceptions import ClientError  # noqa: E402

from apps.documents.storage import S3Storage  # noqa: E402

pytestmark = pytest.mark.req("DOC-002")


@pytest.fixture
def s3():
    with moto.mock_aws():
        storage = S3Storage(
            bucket="erp-docs",
            region="us-east-1",
            access_key="test",
            secret_key="test",
            prefix="tenant-a",
            addressing_style="path",
        )
        storage.client.create_bucket(Bucket="erp-docs")
        yield storage


def test_put_never_overwrites_an_existing_version(s3):
    s3.put("doc/1/v1", io.BytesIO(b"first"), content_type="application/pdf", size=5)
    body = s3.client.get_object(Bucket="erp-docs", Key="tenant-a/doc/1/v1")["Body"].read()
    assert body == b"first"
    with pytest.raises(ClientError) as exc:
        s3.put("doc/1/v1", io.BytesIO(b"second"), content_type="application/pdf", size=6)
    assert exc.value.response["Error"]["Code"] in ("PreconditionFailed", "412")
    assert s3.client.get_object(Bucket="erp-docs", Key="tenant-a/doc/1/v1")["Body"].read() == b"first"


def test_presigned_get_is_short_lived_and_forces_download_name(s3):
    s3.put("doc/2/v1", io.BytesIO(b"x"), content_type="text/plain", size=1)
    url = s3.presigned_get("doc/2/v1", filename="Invoice March.pdf", content_type="application/pdf", expires_in=3600)
    query = parse_qs(urlparse(url).query)
    assert query["X-Amz-Expires"] == ["300"]  # capped at five minutes
    assert "attachment" in query["response-content-disposition"][0]
    assert urlparse(url).path == "/erp-docs/tenant-a/doc/2/v1"


def test_keys_cannot_escape_the_prefix(s3):
    with pytest.raises(Exception):
        s3.put("../other-tenant/x", io.BytesIO(b"x"), content_type="text/plain", size=1)


def test_delete(s3):
    s3.put("doc/3/v1", io.BytesIO(b"x"), content_type="text/plain", size=1)
    s3.delete("doc/3/v1")
    with pytest.raises(ClientError):
        s3.client.head_object(Bucket="erp-docs", Key="tenant-a/doc/3/v1")


def test_links_are_signed_for_the_public_address():
    with moto.mock_aws():
        storage = S3Storage(
            bucket="erp-docs",
            endpoint_url="http://minio:9000",
            region="us-east-1",
            access_key="test",
            secret_key="test",
            public_endpoint_url="https://files.erp.example",
        )
        url = storage.presigned_get("doc/9/v1", filename="a.pdf", content_type="application/pdf", expires_in=60)
        assert url.startswith("https://files.erp.example/erp-docs/doc/9/v1?")
