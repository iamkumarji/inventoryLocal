#!/bin/sh
# One-off MinIO setup (idempotent): documents bucket with versioning, and an application user that
# can only read/write objects in that bucket. The app never uses the MinIO root credentials.
set -eu
mc alias set erp http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "erp/$DOCUMENTS_S3_BUCKET"
mc version enable "erp/$DOCUMENTS_S3_BUCKET"          # overwritten/deleted objects stay recoverable
mc anonymous set none "erp/$DOCUMENTS_S3_BUCKET"
cat > /tmp/erp-documents.json <<JSON
{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
   "Resource": ["arn:aws:s3:::$DOCUMENTS_S3_BUCKET/*"]},
  {"Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
   "Resource": ["arn:aws:s3:::$DOCUMENTS_S3_BUCKET"]}
]}
JSON
mc admin policy create erp erp-documents /tmp/erp-documents.json 2>/dev/null || true
mc admin user add erp "$DOCUMENTS_S3_ACCESS_KEY" "$DOCUMENTS_S3_SECRET_KEY"
mc admin policy attach erp erp-documents --user "$DOCUMENTS_S3_ACCESS_KEY" 2>/dev/null || true
echo "minio ready: bucket $DOCUMENTS_S3_BUCKET (versioned), app user $DOCUMENTS_S3_ACCESS_KEY"
