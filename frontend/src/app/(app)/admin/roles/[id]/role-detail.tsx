"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Lock, ShieldAlert } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus, StatusBadge } from "@/components/erp/status";
import { ErrorState, PageSkeleton, RowsSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, unwrap } from "@/lib/api/client";
import { usePermissionCatalog } from "@/lib/api/hooks";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { useSession } from "@/lib/session";

import { slugify } from "../roles-view";

type Permission = components["schemas"]["Permission"];

const ACTION_ORDER = ["read", "create", "update", "delete", "approve", "reject", "post", "cancel", "assign", "manage", "export", "download"];
const MODULE_LABEL: Record<string, string> = {
  organization: "Organization", identity: "Identity", authorization: "Access control", audit: "Audit", core: "Platform",
  approvals: "Approvals", notifications: "Notifications",
};
const RESOURCE_LABEL: Record<string, string> = { sod_rule: "Segregation-of-duties rule", auth_session: "Sign-in session" };
const human = (s: string) => RESOURCE_LABEL[s] ?? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function PermissionMatrix({ catalog, selected, onToggle, readOnly }: {
  catalog: Permission[];
  selected: Set<string>;
  onToggle: (code: string, on: boolean) => void;
  readOnly: boolean;
}) {
  const actions = useMemo(() => {
    const present = new Set(catalog.map((p) => p.action));
    return [...ACTION_ORDER.filter((a) => present.has(a)), ...[...present].filter((a) => !ACTION_ORDER.includes(a)).sort()];
  }, [catalog]);
  const modules = useMemo(() => {
    const grouped = new Map<string, Map<string, Map<string, Permission>>>();
    for (const p of catalog) {
      const resources = grouped.get(p.module) ?? new Map();
      const perms = resources.get(p.resource) ?? new Map();
      perms.set(p.action, p);
      resources.set(p.resource, perms);
      grouped.set(p.module, resources);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [catalog]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b">
            <th className="px-5 py-2.5 text-left text-xs font-medium text-muted-foreground">Resource</th>
            {actions.map((a) => <th key={a} className="px-2 py-2.5 text-center text-xs font-medium text-muted-foreground">{human(a)}</th>)}
          </tr>
        </thead>
        {modules.map(([module, resources]) => (
          <tbody key={module}>
            <tr><th colSpan={actions.length + 1} className="type-section bg-muted/60 px-5 py-2 text-left">{MODULE_LABEL[module] ?? human(module)}</th></tr>
            {[...resources.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([resource, perms]) => (
              <tr key={resource} className="border-b last:border-0 hover:bg-accent/40">
                <td className="px-5 py-2">{human(resource)}</td>
                {actions.map((action) => {
                  const p = perms.get(action);
                  if (!p) return <td key={action} className="px-2 py-2 text-center text-muted-foreground/40" aria-hidden>·</td>;
                  return (
                    <td key={action} className="px-2 py-2 text-center">
                      <span className="inline-flex items-center gap-1">
                        <Checkbox checked={selected.has(p.code)} disabled={readOnly} aria-label={`${human(resource)}: ${human(action)}`}
                          onCheckedChange={(v) => onToggle(p.code, v === true)} />
                        {(p.requires_mfa || p.is_sensitive) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>{p.requires_mfa ? <Lock className="size-3 text-status-info" aria-label="Needs recent two-step check" /> : <ShieldAlert className="size-3 text-status-pending" aria-label="Sensitive: every use is audited" />}</span>
                            </TooltipTrigger>
                            <TooltipContent>{p.requires_mfa ? "Needs a recent two-step check each time" : "Sensitive: every use is audited"}</TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function CloneRole({ id, sourceName }: { id: string; sourceName: string }) {
  const router = useRouter();
  const { withStepUp } = useStepUp();
  const [name, setName] = useState(sourceName.replace(" (template)", ""));
  const [code, setCode] = useState(slugify(sourceName.replace(" (template)", "")));
  const clone = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/authorization/roles/{id}/clone/", { params: { path: { id } }, body: { name, code } }))),
    onSuccess: (role) => router.push(`/admin/roles/${role.id}`),
  });
  return (
    <Dialog>
      <DialogTrigger asChild><Button><Copy aria-hidden /> Clone</Button></DialogTrigger>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); clone.mutate(); }}>
          <DialogHeader><DialogTitle>Clone into a custom role</DialogTitle></DialogHeader>
          <FormError message={clone.error ? (isApiError(clone.error) ? clone.error.summary() : "Couldn't reach the server.") : undefined} />
          <Field id="clone-name" label="Name"><Input id="clone-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field id="clone-code" label="Code"><Input id="clone-code" value={code} onChange={(e) => setCode(e.target.value)} className="num" /></Field>
          <DialogFooter><Button type="submit" disabled={clone.isPending}>Clone role</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RoleDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const role = useQuery({ queryKey: ["authorization", "role", id], queryFn: () => unwrap(api.GET("/api/v1/authorization/roles/{id}/", { params: { path: { id } } })) });
  const catalog = usePermissionCatalog();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState({ name: "", description: "", mfa_required: false, is_active: true });
  // Reset local edits whenever a new server version arrives (derived during render, not in an effect).
  const [syncedVersion, setSyncedVersion] = useState<number | null>(null);
  if (role.data && role.data.version !== syncedVersion) {
    setSyncedVersion(role.data.version);
    setSelected(new Set(role.data.permission_codes));
    setSettings({ name: role.data.name, description: role.data.description, mfa_required: role.data.mfa_required, is_active: role.data.is_active });
  }

  const onSaved = (data: components["schemas"]["Role"], message: string) => {
    queryClient.setQueryData(["authorization", "role", id], data);
    queryClient.invalidateQueries({ queryKey: ["authorization", "roles"] });
    toast(message);
  };
  const savePermissions = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.PUT("/api/v1/authorization/roles/{id}/permissions/", {
      params: { path: { id } }, body: { permission_codes: [...selected], version: role.data!.version },
    }))),
    onSuccess: (data) => onSaved(data, "Permissions saved"),
  });
  const saveSettings = useMutation({
    mutationFn: () => unwrap(api.PATCH("/api/v1/authorization/roles/{id}/", { params: { path: { id } }, body: { ...settings, version: role.data!.version } })),
    onSuccess: (data) => onSaved(data, "Role saved"),
  });

  if (role.isLoading) return <PageSkeleton />;
  if (role.error) return <ErrorState error={role.error} onRetry={role.refetch} />;
  const r = role.data!;
  const readOnly = r.is_system_template || !can("authorization.role.manage");
  const original = new Set(r.permission_codes);
  const added = [...selected].filter((c) => !original.has(c)).length;
  const removed = [...original].filter((c) => !selected.has(c)).length;
  const saveError = savePermissions.error ?? saveSettings.error;
  const errorMessage = !saveError ? undefined : isApiError(saveError, "version_conflict")
    ? "Someone else changed this role. Reload to see their changes."
    : isApiError(saveError) ? saveError.summary() : "Couldn't reach the server.";

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Roles", href: "/admin/roles" }, { label: r.name }]}
        title={r.name}
        description={r.description || undefined}
        meta={<><ActiveStatus active={r.is_active} />{r.is_system_template && <StatusBadge tone="info">Template, read-only</StatusBadge>}<span className="num text-muted-foreground">{r.code}</span></>}
        actions={r.is_system_template && can("authorization.role.create") && <CloneRole id={r.id} sourceName={r.name} />}
      />
      <FormError message={errorMessage} />
      <div className="mt-4 grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Section
          title="Permissions"
          description={`${selected.size} selected. Each action is granted separately; nothing is implied.`}
          actions={!readOnly && (added > 0 || removed > 0) && (
            <div className="flex items-center gap-3">
              <span className="num text-sm text-muted-foreground">+{added} / −{removed}</span>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(original))}>Discard</Button>
              <Button size="sm" onClick={() => savePermissions.mutate()} disabled={savePermissions.isPending}>Save permissions</Button>
            </div>
          )}
        >
          {catalog.isLoading ? <RowsSkeleton /> : catalog.error ? <ErrorState error={catalog.error} /> : (
            <PermissionMatrix catalog={catalog.data!} selected={selected} readOnly={readOnly}
              onToggle={(code, on) => setSelected((prev) => { const next = new Set(prev); if (on) next.add(code); else next.delete(code); return next; })} />
          )}
        </Section>
        <Section title="Settings">
          <form className="grid gap-4 px-5 py-4" onSubmit={(e) => { e.preventDefault(); saveSettings.mutate(); }}>
            <Field id="role-name" label="Name"><Input id="role-name" value={settings.name} disabled={r.is_system_template} onChange={(e) => setSettings({ ...settings, name: e.target.value })} /></Field>
            <Field id="role-desc" label="Description"><Input id="role-desc" value={settings.description} disabled={r.is_system_template} onChange={(e) => setSettings({ ...settings, description: e.target.value })} /></Field>
            <div className="flex items-center justify-between">
              <Label htmlFor="role-mfa" className="font-normal">Holders must use two-step verification</Label>
              <Switch id="role-mfa" checked={settings.mfa_required} disabled={r.is_system_template} onCheckedChange={(v) => setSettings({ ...settings, mfa_required: v })} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="role-active" className="font-normal">Active</Label>
              <Switch id="role-active" checked={settings.is_active} disabled={r.is_system_template} onCheckedChange={(v) => setSettings({ ...settings, is_active: v })} />
            </div>
            {!r.is_system_template && can("authorization.role.update") && <Button type="submit" variant="outline" disabled={saveSettings.isPending}>Save settings</Button>}
          </form>
        </Section>
      </div>
    </>
  );
}
