from apps.authorization.registry import resource_permissions

# Comments are additionally delegated to the target record: commenting on or reading the comments of a
# record also requires `<record type>.read` on that record (apps/collaboration/records.py).
PERMISSIONS = [
    *resource_permissions("collaboration.task", ["create", "read", "update", "assign"], "tasks"),
    *resource_permissions("collaboration.comment", ["create", "read", "update"], "comments on records"),
    *resource_permissions("collaboration.escalation_rule", ["create", "read", "update"], "task escalation rules"),
]
