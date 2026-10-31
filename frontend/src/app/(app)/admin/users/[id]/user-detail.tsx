"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Lock, LogOut, Power, ShieldOff } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState, ErrorState, PageSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { ago, dateTime } from "@/lib/format";
import { SCOPE_TYPE_LABEL, useScopeOptions } from "@/lib/scopes";
import { useSession } from "@/lib/session";

import { UserState } from "../users-view";

type Assignment = components["schemas"]["RoleAssignment"];
type AdminAction = "deactivate" | "activate" | "unlock" | "reset-mfa" | "revoke-sessions";

const ACTION_COPY: Record<AdminAction, { label: string; title: string; body: string; done: string }> = {
  deactivate: { label: "Deactivate", title: "Deactivate this user?", body: "They're signed out everywhere and can't sign in. Their history stays intact.", done: "User deactivated" },
  activate: { label: "Reactivate", title: "Reactivate this user?", body: "They can sign in again with their existing password.", done: "User reactivated" },
  unlock: { label: "Unlock", title: "Unlock this account?", body: "Clears failed sign-in attempts so they can try again now.", done: "Account unlocked" },
  "reset-mfa": { label: "Reset two-step", title: "Reset two-step verification?", body: "Removes their authenticator and recovery codes and signs them out. They set it up again at next sign-in.", done: "Two-step verification reset" },
  "revoke-sessions": { label: "Sign out everywhere", title: "Sign this user out everywhere?", body: "Ends every session on every device.", done: "Signed out of all devices" },
};
const ACTION_ICON = { deactivate: Power, activate: Power, unlock: Lock, "reset-mfa": ShieldOff, "revoke-sessions": LogOut };

export function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const scopes = useScopeOptions();
  const user = useQuery({ queryKey: ["identity", "user", id], queryFn: () => unwrap(api.GET("/api/v1/identity/users/{id}/", { params: { path: { id } } })) });
  const grants = useQuery({
    queryKey: ["authorization", "assignments", "user", id],
    queryFn: () => unwrap(api.GET("/api/v1/authorization/role-assignments/", { params: { query: { user: id, active: true } } })),
    enabled: can("authorization.role_assignment.read"),
  });
  const sessions = useQuery({
    queryKey: ["identity", "user", id, "sessions"],
    queryFn: () => unwrap(api.GET("/api/v1/identity/users/{id}/sessions/", { params: { path: { id } } })),
    enabled: can("identity.auth_session.read"),
  });
  const [profile, setProfile] = useState({ full_name: "", phone: "" });
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  if (user.data && user.data.updated_at !== syncedAt) {
    setSyncedAt(user.data.updated_at);
    setProfile({ full_name: user.data.full_name, phone: user.data.phone });
  }

  const act = useMutation({
    mutationFn: (action: AdminAction) => withStepUp<unknown>(() => {
      const path = { params: { path: { id } } };
      switch (action) {
        case "deactivate": return unwrap(api.POST("/api/v1/identity/users/{id}/deactivate/", path));
        case "activate": return unwrap(api.POST("/api/v1/identity/users/{id}/activate/", path));
        case "unlock": return unwrap(api.POST("/api/v1/identity/users/{id}/unlock/", path));
        case "reset-mfa": return unwrap(api.POST("/api/v1/identity/users/{id}/reset-mfa/", path));
        default: return unwrap(api.POST("/api/v1/identity/users/{id}/revoke-sessions/", path));
      }
    }),
    onSuccess: (_, action) => {
      queryClient.invalidateQueries({ queryKey: ["identity"] });
      toast(ACTION_COPY[action].done);
    },
    onError: (error) => toast.error(isApiError(error) ? error.summary() : "Couldn't reach the server."),
  });
  const save = useMutation({
    mutationFn: () => unwrap(api.PATCH("/api/v1/identity/users/{id}/", { params: { path: { id } }, body: profile })),
    onSuccess: (data) => {
      queryClient.setQueryData(["identity", "user", id], data);
      toast("Profile saved");
    },
  });

  if (user.isLoading) return <PageSkeleton />;
  if (user.error) return <ErrorState error={user.error} onRetry={user.refetch} />;
  const u = user.data!;
  const isSelf = u.id === me.user.id;
  const actions: AdminAction[] = [
    ...(u.is_locked ? (["unlock"] as const) : []),
    ...(u.mfa_enrolled && !isSelf ? (["reset-mfa"] as const) : []),
    "revoke-sessions",
    ...(isSelf ? [] : u.is_active ? (["deactivate"] as const) : (["activate"] as const)),
  ];

  const grantColumns: Column<Assignment>[] = [
    { key: "role", header: "Role", cell: (a) => <Link href={`/admin/roles/${a.role}`} className="underline-offset-4 hover:underline">{a.role_code}</Link> },
    { key: "scope", header: "Where", cell: (a) => <span>{SCOPE_TYPE_LABEL[a.scope_type]}: {scopes.label(a.scope_id)}</span> },
    { key: "until", header: "Until", cell: (a) => a.valid_until ? dateTime(a.valid_until) : "No end date" },
    { key: "reason", header: "Reason", cell: (a) => <span className="text-muted-foreground">{a.reason}</span> },
  ];

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Users", href: "/admin/users" }, { label: u.full_name }]}
        title={u.full_name}
        meta={<><UserState user={u} /><span className="text-muted-foreground">{u.email}</span><span className="text-muted-foreground">Last sign-in {u.last_login ? ago(u.last_login) : "never"}</span></>}
        actions={can("identity.user.manage") && actions.map((action) => {
          const Icon = ACTION_ICON[action];
          const copy = ACTION_COPY[action];
          return (
            <AlertDialog key={action}>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={act.isPending}><Icon aria-hidden /> {copy.label}</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{copy.title}</AlertDialogTitle>
                  <AlertDialogDescription>{copy.body}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => act.mutate(action)}>{copy.label}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        })}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          {can("authorization.role_assignment.read") && (
            <Section title="Access grants" description="Roles this person holds and where they apply."
              actions={can("authorization.role_assignment.assign") && <Button size="sm" variant="outline" asChild><Link href={`/admin/access?user=${u.id}&grant=1`}><KeyRound aria-hidden /> Grant access</Link></Button>}>
              <DataTable columns={grantColumns} rows={grants.data?.results} isLoading={grants.isLoading} error={grants.error}
                empty={<EmptyState title="No access yet" description="This person can sign in but can't see any module." />} />
            </Section>
          )}
          {can("identity.auth_session.read") && (
            <Section title="Active sessions">
              {sessions.data && sessions.data.length === 0 ? <EmptyState title="Not signed in anywhere" /> : (
                <ul className="divide-y">
                  {sessions.data?.map((s) => (
                    <li key={s.id} className="px-5 py-3 text-sm">
                      <p className="font-medium">{s.user_agent || s.client_type}</p>
                      <p className="text-muted-foreground">{s.ip}, active {ago(s.last_seen_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
        </div>
        <Section title="Profile">
          <form className="grid gap-4 px-5 py-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <FormError message={save.error ? (isApiError(save.error) ? save.error.summary() : "Couldn't reach the server.") : undefined} />
            <Field id="full_name" label="Full name"><Input id="full_name" value={profile.full_name} onChange={(e) => setProfile({ ...profile, full_name: e.target.value })} disabled={!can("identity.user.update")} /></Field>
            <Field id="phone" label="Phone"><Input id="phone" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} disabled={!can("identity.user.update")} /></Field>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Two-step</dt>
              <dd>{u.mfa_enrolled ? <StatusBadge tone="approved">On</StatusBadge> : u.mfa_enforced ? <StatusBadge tone="pending">Required, not set up</StatusBadge> : "Off"}</dd>
              <dt className="text-muted-foreground">Created</dt><dd>{dateTime(u.created_at)}</dd>
            </dl>
            {can("identity.user.update") && <Button type="submit" variant="outline" disabled={save.isPending} className="justify-self-start">Save profile</Button>}
          </form>
        </Section>
      </div>
    </>
  );
}
