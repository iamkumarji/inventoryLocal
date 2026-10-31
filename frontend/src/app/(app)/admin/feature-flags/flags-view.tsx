"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { ago } from "@/lib/format";
import { useSession } from "@/lib/session";

type FlagRow = components["schemas"]["FeatureFlag"];

function targeting(rules: FlagRow["rules"]): string {
  const r = (rules ?? {}) as Record<string, Record<string, boolean>>;
  const parts = [["companies", "company"], ["roles", "role"], ["users", "person"]].map(([key, noun]) => {
    const n = Object.keys(r[key] ?? {}).length;
    return n ? `${n} ${noun}${n === 1 ? "" : "s"}` : null;
  }).filter(Boolean);
  return parts.length ? `Overrides for ${parts.join(", ")}` : "No overrides";
}

export function FlagsView() {
  const { can } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["core", "flags"], queryFn: () => unwrap(api.GET("/api/v1/admin/feature-flags/")) });
  const toggle = useMutation({
    mutationFn: (f: FlagRow) => withStepUp(() => unwrap(api.PATCH("/api/v1/admin/feature-flags/{id}/", { params: { path: { id: f.id } }, body: { enabled_default: !f.enabled_default } }))),
    onSuccess: (f) => {
      queryClient.invalidateQueries({ queryKey: ["core", "flags"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      toast(`${f.key} ${f.enabled_default ? "turned on" : "turned off"}`);
    },
    onError: (e) => toast.error(isApiError(e) ? e.summary() : "Couldn't reach the server."),
  });
  const columns: Column<FlagRow>[] = [
    { key: "key", header: "Flag", cell: (f) => <span><span className="num block">{f.key}</span><span className="block text-xs text-muted-foreground">{f.description}</span></span> },
    { key: "rules", header: "Targeting", cell: (f) => <span className="text-muted-foreground">{targeting(f.rules)}</span> },
    { key: "updated", header: "Changed", cell: (f) => <span className="text-muted-foreground">{ago(f.updated_at)}</span> },
    { key: "on", header: "On for everyone else", align: "right", cell: (f) => (
      <Switch checked={f.enabled_default} disabled={!can("core.feature_flag.manage") || toggle.isPending} aria-label={`${f.key} on by default`} onCheckedChange={() => toggle.mutate(f)} />
    ) },
  ];
  return (
    <>
      <PageHeader title="Feature flags" description="Unfinished modules stay off until they pass their acceptance tests. Module flags are named module.<name>." />
      <Section>
        <DataTable columns={columns} rows={query.data} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          empty={<EmptyState icon={Flag} title="No flags defined" description="Flags appear here as modules ship. Platform modules don't need one." />} />
      </Section>
    </>
  );
}
