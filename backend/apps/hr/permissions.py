from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions(
        "hr.employee", ["create", "read", "update", "export"], "employees", sensitive=["update", "export"]
    ),
    *resource_permissions("hr.attendance", ["create", "read", "update"], "attendance records"),
    *resource_permissions("hr.leave_type", ["create", "read", "update"], "leave types"),
    *resource_permissions("hr.leave_balance", ["create", "read", "update"], "leave balances"),
    *resource_permissions(
        "hr.leave_request", ["create", "read", "update", "approve", "reject", "cancel"], "leave requests"
    ),
    *resource_permissions(
        "hr.salary_structure", ["create", "read", "update"], "salary structures and components", sensitive=["update"]
    ),
    # Employee salary amounts: sensitive and MFA-protected (docs/RBAC_ABAC.md §9).
    *resource_permissions(
        "hr.salary", ["create", "read", "update"], "employee salaries", mfa=["create", "read", "update"]
    ),
    *resource_permissions(
        "hr.payroll_run",
        ["create", "read", "update", "approve", "reject", "post", "reverse"],
        "payroll runs",
        sensitive=["create", "read", "update", "reject"],
        mfa=["approve", "post", "reverse"],
    ),
    *resource_permissions("hr.payslip", ["read", "download"], "payslips", sensitive=["read", "download"]),
]
