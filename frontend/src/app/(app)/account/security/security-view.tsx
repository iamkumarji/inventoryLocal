"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, ShieldCheck, ShieldAlert, Smartphone } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader, Section } from "@/components/erp/page-header";
import { PasswordChangeForm } from "@/components/erp/password-change-form";
import { StatusBadge } from "@/components/erp/status";
import { ErrorState, RowsSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { ago, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

function Sessions() {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: ["auth", "sessions"], queryFn: () => unwrap(api.GET("/api/v1/auth/sessions/")) });
  const revoke = useMutation({
    mutationFn: (id: string) => api.DELETE("/api/v1/auth/sessions/{id}/", { params: { path: { id } } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] });
      toast("Signed out of that device");
    },
  });
  if (sessions.isLoading) return <RowsSkeleton rows={2} />;
  if (sessions.error) return <ErrorState error={sessions.error} onRetry={sessions.refetch} />;
  return (
    <ul className="divide-y">
      {sessions.data!.map((s) => (
        <li key={s.id} className="flex items-center gap-4 px-5 py-3">
          {s.client_type === "mobile" ? <Smartphone className="size-5 text-muted-foreground" aria-hidden /> : <Laptop className="size-5 text-muted-foreground" aria-hidden />}
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{s.user_agent || (s.client_type === "mobile" ? "Mobile app" : "Browser")}</p>
            <p className="text-sm text-muted-foreground">
              {s.ip ?? "Unknown address"}, active {ago(s.last_seen_at)}, signed in {dateTime(s.created_at)}
            </p>
          </div>
          {s.is_current ? <StatusBadge tone="info">This device</StatusBadge> : (
            <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)}>Sign out</Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function RecoveryCodes() {
  const { withStepUp } = useStepUp();
  const [codes, setCodes] = useState<string[] | null>(null);
  const regenerate = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/auth/mfa/recovery-codes/regenerate/"))),
    onSuccess: (data) => setCodes(data.recovery_codes),
  });
  return (
    <div className="px-5 py-4">
      {codes ? (
        <>
          <p className="text-sm">New codes. The old ones no longer work. Store these now; they won&apos;t be shown again.</p>
          <ol className="num mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm tracking-wider sm:grid-cols-5">
            {codes.map((c) => <li key={c}>{c}</li>)}
          </ol>
        </>
      ) : (
        <Button variant="outline" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          Create new recovery codes
        </Button>
      )}
    </div>
  );
}

type Preference = Omit<components["schemas"]["PreferenceRequest"], "mandatory">;

const CATEGORIES: Record<string, string> = { approval: "Approvals", task: "Tasks", security: "Security", system: "System" };
const CHANNELS: Record<string, string> = { in_app: "In the app", email: "Email", push: "Mobile push" };

function NotificationPreferences() {
  const queryClient = useQueryClient();
  const prefs = useQuery({
    queryKey: ["notifications", "preferences"],
    queryFn: () => unwrap(api.GET("/api/v1/notifications/preferences/")),
  });
  const save = useMutation({
    mutationFn: (body: Preference) => unwrap(api.PUT("/api/v1/notifications/preferences/", { body: [body] })),
    onSuccess: (data) => queryClient.setQueryData(["notifications", "preferences"], data),
  });
  if (prefs.isLoading) return <RowsSkeleton rows={4} />;
  if (prefs.error) return <ErrorState error={prefs.error} />;
  const lookup = new Map(prefs.data!.map((p) => [`${p.category}:${p.channel}`, p]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-5 py-2.5 font-medium">Topic</th>
            {Object.values(CHANNELS).map((c) => <th key={c} className="px-5 py-2.5 font-medium">{c}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y">
          {Object.entries(CATEGORIES).map(([category, label]) => (
            <tr key={category}>
              <td className="px-5 py-3 font-medium">{label}</td>
              {Object.keys(CHANNELS).map((channel) => {
                const p = lookup.get(`${category}:${channel}`)!;
                return (
                  <td key={channel} className="px-5 py-3">
                    <Switch
                      checked={p.enabled}
                      disabled={p.mandatory || save.isPending}
                      aria-label={`${label}: ${CHANNELS[channel]}`}
                      onCheckedChange={(enabled) => save.mutate({ category: p.category, channel: p.channel, enabled })}
                    />
                    {p.mandatory && <span className="ml-2 text-xs text-muted-foreground">Always on</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SecurityView() {
  const { me } = useSession();
  const url = useUrlState();
  const tab = url.get("tab") || "security";
  return (
    <>
      <PageHeader title="Account" description={`Signed in as ${me.user.email}.`} />
      <Tabs value={tab} onValueChange={(value) => url.set({ tab: value === "security" ? null : value })}>
        <TabsList className="mb-4">
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
        </TabsList>
        <TabsContent value="security" className="grid gap-6 lg:grid-cols-2">
          <div className="grid content-start gap-6">
            <Section title="Two-step verification">
              <div className="flex items-start gap-3 px-5 py-4">
                {me.mfa.enrolled ? <ShieldCheck className="mt-0.5 size-5 text-status-approved" aria-hidden /> : <ShieldAlert className="mt-0.5 size-5 text-status-pending" aria-hidden />}
                <div className="text-sm">
                  <p className="font-medium">{me.mfa.enrolled ? "On, using an authenticator app" : "Off"}</p>
                  <p className="text-muted-foreground">
                    {me.mfa.enrolled
                      ? "Lost your phone? Sign in with a recovery code, then ask an administrator to reset your authenticator."
                      : me.mfa.required ? "Your role requires it." : "Turn it on to protect approvals made in your name."}
                  </p>
                  {!me.mfa.enrolled && <Button asChild size="sm" className="mt-3"><Link href="/setup/mfa">Set up now</Link></Button>}
                </div>
              </div>
              {me.mfa.enrolled && <div className="border-t"><RecoveryCodes /></div>}
            </Section>
            <Section title="Where you're signed in" description="Sign out of devices you don't recognise.">
              <Sessions />
            </Section>
          </div>
          <Section title="Change password" description="Changing it signs you out everywhere else.">
            <div className="px-5 py-4">
              <PasswordChangeForm onDone={() => toast("Password changed")} />
            </div>
          </Section>
        </TabsContent>
        <TabsContent value="notifications">
          <Section title="How you're notified" description="Approval and security alerts always appear in the app.">
            <NotificationPreferences />
          </Section>
        </TabsContent>
      </Tabs>
    </>
  );
}
