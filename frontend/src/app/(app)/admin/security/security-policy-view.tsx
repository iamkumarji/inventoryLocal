"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, RowsSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { ME_KEY, useSession } from "@/lib/session";

type Policy = { require_mfa_for_all: boolean; require_mfa_for_sensitive_actions: boolean };
const KEY = ["organization", "security"] as const;

const SETTINGS: { key: keyof Policy; label: string; on: string; off: string }[] = [
  {
    key: "require_mfa_for_all",
    label: "Two-step sign-in for everyone",
    on: "Every user must set up an authenticator app; people who haven't are asked to at their next sign-in.",
    off: "Only people whose role or account requires it must use two-step sign-in. Others can turn it on for themselves.",
  },
  {
    key: "require_mfa_for_sensitive_actions",
    label: "Fresh code before sensitive actions",
    on: "Posting payments and payroll, viewing salaries and similar actions ask for a code from the last 15 minutes.",
    off: "Sensitive actions don't ask for a fresh code. Approval limits, maker-checker and audit still apply.",
  },
];

export function SecurityPolicyView() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const { withStepUp } = useStepUp();
  const policy = useQuery({ queryKey: KEY, queryFn: () => unwrap(api.GET("/api/v1/organization/security/")) as Promise<Policy> });
  const update = useMutation({
    mutationFn: (body: Partial<Policy>) => withStepUp(() => unwrap(api.PATCH("/api/v1/organization/security/", { body }))),
    onSuccess: (data, body) => {
      queryClient.setQueryData(KEY, data);
      queryClient.invalidateQueries({ queryKey: ME_KEY });
      const [key, value] = Object.entries(body)[0];
      toast(`${SETTINGS.find((s) => s.key === key)?.label} turned ${value ? "on" : "off"}`);
    },
  });
  const editable = can("organization.organization.update");

  return (
    <>
      <PageHeader title="Sign-in security" description="Two-step sign-in rules for everyone in your organization. Changes are recorded in the audit log." />
      <Section title="Two-step sign-in" description="Platform operators always use two-step sign-in; it can't be switched off for them.">
        {policy.isLoading ? <RowsSkeleton rows={2} /> : policy.error ? <ErrorState error={policy.error} onRetry={policy.refetch} /> : (
          <ul className="divide-y">
            {SETTINGS.map((setting) => {
              const value = policy.data![setting.key];
              return (
                <li key={setting.key} className="flex items-start justify-between gap-4 px-5 py-4">
                  <div className="min-w-0 text-sm">
                    <Label htmlFor={setting.key} className="font-medium">{setting.label}</Label>
                    <p className="mt-0.5 text-muted-foreground">{value ? setting.on : setting.off}</p>
                  </div>
                  <Switch
                    id={setting.key}
                    checked={value}
                    disabled={!editable || update.isPending}
                    onCheckedChange={(next) => update.mutate({ [setting.key]: next })}
                  />
                </li>
              );
            })}
          </ul>
        )}
        <div className="px-5 pb-4">
          <FormError message={update.error ? (isApiError(update.error) ? update.error.summary() : "Couldn't reach the server.") : undefined} />
          {!editable && <p className="text-sm text-muted-foreground">Only administrators who can update the organization can change these.</p>}
        </div>
      </Section>
    </>
  );
}
