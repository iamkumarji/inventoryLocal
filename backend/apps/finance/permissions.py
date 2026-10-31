from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("finance.account", ["create", "read", "update"], "chart of accounts", sensitive=["update"]),
    *resource_permissions("finance.cost_center", ["create", "read", "update"], "cost centres"),
    *resource_permissions(
        "finance.posting_rule",
        ["create", "read", "update"],
        "posting rules (account determination)",
        mfa=["create", "update"],
    ),
    *resource_permissions(
        "finance.journal_entry",
        ["create", "read", "post", "cancel", "export", "self_approve"],
        "journal entries",
        sensitive=["export"],
        mfa=["post", "cancel", "self_approve"],
    ),
    *resource_permissions("finance.report", ["read", "export"], "financial statements", sensitive=["export"]),
    *resource_permissions(
        "finance.supplier_invoice",
        ["create", "read", "update", "approve", "reject", "post", "export"],
        "supplier invoices",
        sensitive=["export"],
    ),
    *resource_permissions(
        "finance.payment",
        ["create", "read", "update", "approve", "reject", "post", "export"],
        "payments and receipts",
        sensitive=["export"],
        mfa=["approve", "post"],
    ),
    *resource_permissions(
        "finance.bank_account", ["create", "read", "update"], "bank accounts and statements", sensitive=["update"]
    ),
    *resource_permissions("finance.open_item", ["read", "export"], "receivables and payables", sensitive=["export"]),
    *resource_permissions("finance.budget", ["create", "read", "update", "approve"], "budgets"),
    *resource_permissions("finance.period", ["read", "manage"], "period and year-end close", mfa=["manage"]),
    *resource_permissions("finance.gst", ["read", "export"], "GST returns data", sensitive=["export"]),
]
