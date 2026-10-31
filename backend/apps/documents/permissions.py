from apps.authorization.registry import resource_permissions

# Record-linked documents additionally require `<record type>.read` on the linked record; confidential
# documents additionally require an explicit DocumentACL entry (apps/documents/services.py).
PERMISSIONS = resource_permissions(
    "documents.document",
    ["create", "read", "update", "delete", "download", "share", "manage"],
    "documents",
    sensitive=["delete", "download", "manage"],
)
