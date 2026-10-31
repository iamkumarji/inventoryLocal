from apps.authorization.registry import resource_permissions

# Dashboards and reports only open the door: every figure inside also needs the permission of the
# domain it comes from (finance.report.read, inventory.stock_balance.read, ...), so analytics never
# shows data the user couldn't see in the source module.
PERMISSIONS = [
    *resource_permissions("analytics.dashboard", ["read"], "role dashboards and KPIs"),
    *resource_permissions("analytics.report", ["create", "read"], "report exports (async)"),
    *resource_permissions("analytics.forecast", ["read"], "demand forecasts"),
]
