"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Waypoints } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { PersonPicker, type Person } from "@/components/erp/person-picker";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { useRoles } from "@/lib/api/hooks";
import type { components } from "@/lib/api/schema";
import { date } from "@/lib/format";
import { SCOPE_TYPE_LABEL, useScopeOptions } from "@/lib/scopes";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type Assignment = components["schemas"]["RoleAssignment"];
type ScopeType = components["schemas"]["RoleAssignmentCreateRequest"]["scope_type"];

function GrantDialog({ open, onOpenChange, initialUser }: { open: boolean; onOpenChange: (o: boolean) => void; initialUser: Person | null }) {
  const queryClient = useQueryClient();
  const { withStepUp } = useStepUp();
  const roles = useRoles();
  const scopes = useScopeOptions();
  const [person, setPerson] = useState<Person | null>(initialUser);
  const [role, setRole] = useState("");
  const [scopeType, setScopeType] = useState<ScopeType>("company");
  const [scopeId, setScopeId] = useState("");
  const [descendants, setDescendants] = useState(true);
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  // Adopt a newly loaded initial user (from ?user=) without an effect.
  const [seenInitial, setSeenInitial] = useState(initialUser);
  if (initialUser !== seenInitial) {
    setSeenInitial(initialUser);
    setPerson(initialUser);
  }

  const grant = useMutation({
    mutationFn: () => {
      const key = idempotencyKey();
      return withStepUp(() => unwrap(api.POST("/api/v1/authorization/role-assignments/", {
        params: { header: { "Idempotency-Key": key } },
        body: {
          user: person!.id, role, scope_type: scopeType, scope_id: scopeId, include_descendants: descendants, reason,
          valid_until: until ? new Date(`${until}T23:59:59`).toISOString() : null,
        },
      })));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["authorization", "assignments"] });
      toast(`Access granted to ${person?.full_name}`);
      onOpenChange(false);
      setRole(""); setScopeId(""); setReason(""); setUntil("");
    },
  });
  const errors = isApiError(grant.error) ? grant.error.fieldErrors() : {};
  const conflict = isApiError(grant.error) && grant.error.problem.code === "sod_conflict";
  const typeOptions = scopes.options.filter((o) => o.type === scopeType);
  const roleOptions = (roles.data?.results ?? []).filter((r) => r.is_active);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); grant.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Grant access</DialogTitle>
            <DialogDescription>Gives a person a role for a part of the organization. Every grant is audited.</DialogDescription>
          </DialogHeader>
          <FormError message={conflict
            ? "This would give the person conflicting duties (segregation of duties). Choose a different role or remove the conflicting one first."
            : grant.error && !isApiError(grant.error, "validation_error") ? (isApiError(grant.error) ? grant.error.summary() : "Couldn't reach the server.") : errors._form} />
          <Field id="person" label="Person" error={errors.user}><PersonPicker id="person" value={person} onChange={setPerson} /></Field>
          <Field id="role" label="Role" error={errors.role}>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="role" className="w-full"><SelectValue placeholder="Choose a role" /></SelectTrigger>
              <SelectContent>{roleOptions.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <Field id="scope-type" label="Applies to">
              <Select value={scopeType} onValueChange={(v) => { setScopeType(v as ScopeType); setScopeId(""); }}>
                <SelectTrigger id="scope-type" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(SCOPE_TYPE_LABEL).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field id="scope" label="Which one" error={errors.scope_id}>
              <Select value={scopeId} onValueChange={setScopeId}>
                <SelectTrigger id="scope" className="w-full"><SelectValue placeholder={typeOptions.length ? "Choose" : "None you can see"} /></SelectTrigger>
                <SelectContent>{typeOptions.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
          {["branch", "facility", "department"].includes(scopeType) && (
            <div className="flex items-start gap-2.5">
              <Checkbox id="descendants" checked={descendants} onCheckedChange={(v) => setDescendants(v === true)} />
              <Label htmlFor="descendants" className="leading-snug font-normal">
                Include everything under it ({scopeType === "department" ? "sub-departments" : "facilities and warehouses"})
              </Label>
            </div>
          )}
          <Field id="until" label="End date" hint="Leave empty for a permanent grant. Temporary cover should always have an end date." error={errors.valid_until}>
            <Input id="until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </Field>
          <Field id="reason" label="Reason" error={errors.reason}>
            <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Joined Pune stores team" required />
          </Field>
          <DialogFooter><Button type="submit" disabled={!person || !role || !scopeId || !reason || grant.isPending}>Grant access</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AccessView() {
  const { can } = useSession();
  const url = useUrlState();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const scopes = useScopeOptions();
  const userFilter = url.get("user");
  const showAll = url.get("show") === "all";
  const [open, setOpen] = useState(() => !!userFilter && url.get("grant") === "1" && can("authorization.role_assignment.assign"));
  const filteredUser = useQuery({
    queryKey: ["identity", "user", userFilter],
    queryFn: () => unwrap(api.GET("/api/v1/identity/users/{id}/", { params: { path: { id: userFilter } } })),
    enabled: !!userFilter && can("identity.user.read"),
  });
  const query = useQuery({
    queryKey: ["authorization", "assignments", userFilter, showAll, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/authorization/role-assignments/", {
      params: { query: { user: userFilter || undefined, active: showAll ? undefined : true, page: url.page } },
    })),
  });
  const revoke = useMutation({
    mutationFn: (a: Assignment) => withStepUp(() => unwrap(api.POST("/api/v1/authorization/role-assignments/{id}/revoke/", {
      params: { path: { id: a.id } }, body: { reason: "Revoked by administrator" },
    }))),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["authorization", "assignments"] }); toast("Access revoked"); },
    onError: (e) => toast.error(isApiError(e) ? e.summary() : "Couldn't reach the server."),
  });

  const columns: Column<Assignment>[] = [
    { key: "user", header: "Person", cell: (a) => <Link href={`/admin/users/${a.user}`} className="hover:underline">{a.user_email}</Link> },
    { key: "role", header: "Role", cell: (a) => <Link href={`/admin/roles/${a.role}`} className="hover:underline">{a.role_code}</Link> },
    { key: "scope", header: "Where", cell: (a) => <span><span className="text-muted-foreground">{SCOPE_TYPE_LABEL[a.scope_type]}:</span> {scopes.label(a.scope_id)}{!a.include_descendants && <span className="text-muted-foreground"> (this level only)</span>}</span> },
    { key: "until", header: "Until", cell: (a) => a.valid_until ? date(a.valid_until) : <span className="text-muted-foreground">No end</span> },
    { key: "status", header: "Status", cell: (a) => a.is_effective ? <StatusBadge tone="approved">In effect</StatusBadge> : a.revoked_at ? <StatusBadge tone="neutral">Revoked</StatusBadge> : <StatusBadge tone="info">Not in effect</StatusBadge> },
    { key: "actions", header: <span className="sr-only">Actions</span>, align: "right", cell: (a) => a.is_effective && can("authorization.role_assignment.assign") && (
      <Button size="sm" variant="ghost" onClick={() => revoke.mutate(a)} disabled={revoke.isPending}>Revoke</Button>
    ) },
  ];
  const initialUser = filteredUser.data ? { id: filteredUser.data.id, full_name: filteredUser.data.full_name, email: filteredUser.data.email } : null;

  return (
    <>
      <PageHeader
        title="Access grants"
        description="Who holds which role, and for which company, branch, plant, warehouse or department."
        actions={can("authorization.role_assignment.assign") && <Button onClick={() => setOpen(true)}><Plus aria-hidden /> Grant access</Button>}
      />
      <Section actions={
        <div className="flex flex-wrap items-center gap-2">
          {userFilter && <Button size="sm" variant="secondary" onClick={() => url.set({ user: null, grant: null })}>{filteredUser.data?.full_name ?? "One person"} ✕</Button>}
          <Button size="sm" variant={showAll ? "ghost" : "secondary"} onClick={() => url.set({ show: null })}>In effect</Button>
          <Button size="sm" variant={showAll ? "secondary" : "ghost"} onClick={() => url.set({ show: "all" })}>Including ended</Button>
        </div>
      }>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          empty={<EmptyState icon={Waypoints} title="No grants match" />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
      <GrantDialog open={open} onOpenChange={setOpen} initialUser={initialUser} />
    </>
  );
}
