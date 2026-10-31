from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("expenses.expense_category", ["create", "read", "update"], "expense categories"),
    *resource_permissions(
        "expenses.expense_claim",
        ["create", "read", "update", "approve", "reject", "pay", "export"],
        "expense claims",
        sensitive=["export"],
        mfa=["pay"],
    ),
    *resource_permissions("expenses.fuel_log", ["create", "read"], "fuel logs"),
    *resource_permissions(
        "expenses.employee_advance",
        ["create", "read", "approve", "reject", "pay"],
        "employee advances",
        mfa=["pay"],
    ),
]
