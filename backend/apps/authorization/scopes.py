"""Organizational scope expansion (docs/RBAC_ABAC.md §2.2).

An assignment's scope node is expanded into concrete ID sets per level. A
resource matches when any of its scope attributes is in the corresponding set.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field, replace
from uuid import UUID

LEVELS = ("organization", "company", "branch", "facility", "warehouse", "department")
# Physical hierarchy, coarse to fine. Departments are an orthogonal tree.
HIERARCHY = ("organization", "company", "branch", "facility", "warehouse")


def finer_levels(level: str) -> tuple[str, ...]:
    return HIERARCHY[HIERARCHY.index(level) + 1 :] if level in HIERARCHY else ()


@dataclass(frozen=True)
class ScopeSet:
    organization: frozenset = frozenset()
    company: frozenset = frozenset()
    branch: frozenset = frozenset()
    facility: frozenset = frozenset()
    warehouse: frozenset = frozenset()
    department: frozenset = frozenset()
    # Levels granted without descendants: they match only records attributed to that exact
    # node, i.e. records whose finer hierarchy levels are empty.
    exact: frozenset = frozenset()
    # Organization of the grant's node. Matches only resources that opt in with a "shared" scope
    # field (organization-wide master data such as items and partners), never security objects.
    shared: frozenset = frozenset()

    def ids(self, level: str) -> frozenset:
        return getattr(self, level)

    def matches(self, scope_values: dict[str, UUID | None]) -> bool:
        for level, value in scope_values.items():
            if value is None or value not in self.ids(level):
                continue
            if level in self.exact and any(scope_values.get(f) is not None for f in finer_levels(level)):
                continue
            return True
        return False

    def is_empty(self) -> bool:
        return not any(self.ids(level) for level in LEVELS)


@dataclass
class OrgTree:
    """Snapshot of the scope hierarchy (small tables; cached with the authz version)."""

    companies_by_org: dict = field(default_factory=lambda: defaultdict(set))
    org_of_company: dict = field(default_factory=dict)
    company_of: dict = field(default_factory=dict)  # branch/facility/warehouse/department -> company
    company_currency: dict = field(default_factory=dict)
    facilities_by_branch: dict = field(default_factory=lambda: defaultdict(set))
    warehouses_by_branch: dict = field(default_factory=lambda: defaultdict(set))
    warehouses_by_facility: dict = field(default_factory=lambda: defaultdict(set))
    department_children: dict = field(default_factory=lambda: defaultdict(set))
    nodes: dict = field(default_factory=dict)  # node id -> scope type

    @classmethod
    def load(cls) -> OrgTree:
        from apps.organization.models import Branch, Company, Department, Facility, Organization, Warehouse

        tree = cls()
        for org_id in Organization.objects.values_list("id", flat=True):
            tree.nodes[org_id] = "organization"
        for company_id, org_id, currency in Company.objects.values_list("id", "organization_id", "base_currency"):
            tree.companies_by_org[org_id].add(company_id)
            tree.org_of_company[company_id] = org_id
            tree.company_currency[company_id] = currency
            tree.nodes[company_id] = "company"
        for branch_id, company_id in Branch.objects.values_list("id", "company_id"):
            tree.company_of[branch_id] = company_id
            tree.nodes[branch_id] = "branch"
        for facility_id, company_id, branch_id in Facility.objects.values_list("id", "company_id", "branch_id"):
            tree.company_of[facility_id] = company_id
            tree.facilities_by_branch[branch_id].add(facility_id)
            tree.nodes[facility_id] = "facility"
        for wh_id, company_id, branch_id, facility_id in Warehouse.objects.values_list(
            "id", "company_id", "branch_id", "facility_id"
        ):
            tree.company_of[wh_id] = company_id
            tree.warehouses_by_branch[branch_id].add(wh_id)
            if facility_id:
                tree.warehouses_by_facility[facility_id].add(wh_id)
            tree.nodes[wh_id] = "warehouse"
        for dept_id, company_id, parent_id in Department.objects.values_list("id", "company_id", "parent_id"):
            tree.company_of[dept_id] = company_id
            if parent_id:
                tree.department_children[parent_id].add(dept_id)
            tree.nodes[dept_id] = "department"
        return tree

    def department_descendants(self, dept_id: UUID) -> set:
        result, stack = set(), [dept_id]
        while stack:
            current = stack.pop()
            if current in result:
                continue
            result.add(current)
            stack.extend(self.department_children.get(current, ()))
        return result

    def expand(self, scope_type: str, scope_id: UUID, include_descendants: bool) -> ScopeSet:
        scope = self._expand(scope_type, scope_id, include_descendants)
        if scope.is_empty():
            return scope
        org = (
            scope_id
            if scope_type == "organization"
            else self.org_of_company.get(scope_id if scope_type == "company" else self.company_of.get(scope_id))
        )
        return replace(scope, shared=frozenset({org}) if org else frozenset())

    def _expand(self, scope_type: str, scope_id: UUID, include_descendants: bool) -> ScopeSet:
        if self.nodes.get(scope_id) != scope_type:
            return ScopeSet()  # dangling or mismatched assignment grants nothing
        if scope_type == "organization":
            return ScopeSet(
                organization=frozenset({scope_id}), company=frozenset(self.companies_by_org.get(scope_id, ()))
            )
        if scope_type == "company":
            exact = frozenset() if include_descendants else frozenset({"company"})
            return ScopeSet(company=frozenset({scope_id}), exact=exact)
        if scope_type == "branch":
            if not include_descendants:
                return ScopeSet(branch=frozenset({scope_id}), exact=frozenset({"branch"}))
            return ScopeSet(
                branch=frozenset({scope_id}),
                facility=frozenset(self.facilities_by_branch.get(scope_id, ())),
                warehouse=frozenset(self.warehouses_by_branch.get(scope_id, ())),
            )
        if scope_type == "facility":
            if not include_descendants:
                return ScopeSet(facility=frozenset({scope_id}), exact=frozenset({"facility"}))
            return ScopeSet(
                facility=frozenset({scope_id}), warehouse=frozenset(self.warehouses_by_facility.get(scope_id, ()))
            )
        if scope_type == "warehouse":
            return ScopeSet(warehouse=frozenset({scope_id}))
        if scope_type == "department":
            depts = self.department_descendants(scope_id) if include_descendants else {scope_id}
            return ScopeSet(department=frozenset(depts))
        return ScopeSet()

    def companies_for(self, scope_type: str, scope_id: UUID) -> frozenset:
        if self.nodes.get(scope_id) != scope_type:
            return frozenset()
        if scope_type == "organization":
            return frozenset(self.companies_by_org.get(scope_id, ()))
        if scope_type == "company":
            return frozenset({scope_id})
        company = self.company_of.get(scope_id)
        return frozenset({company}) if company else frozenset()
