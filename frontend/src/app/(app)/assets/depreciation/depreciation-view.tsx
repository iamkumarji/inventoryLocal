"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LineChart, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ActionDialog } from "@/components/production/action-dialog";
import { StateBadge } from "@/components/production/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { firstOfMonth, today, useOrgPlaces, type DepreciationRun } from "@/lib/api/production";
import { dateTime, money } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";
import { format, parseISO } from "date-fns";

export const monthLabel = (period: string) => format(parseISO(period), "MMMM yyyy");

function NewRun() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { companyId } = useOrgPlaces();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(today().slice(0, 7));
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/assets/depreciation-runs/", { body: { company: companyId, period: firstOfMonth(`${month}-01`) } })),
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ["assets", "runs"] });
      toast(`Draft run for ${monthLabel(run.period)} created. Preview it before posting.`);
      setOpen(false);
      router.push(`/assets/depreciation/${run.id}`);
    },
  });
  return (
    <ActionDialog open={open} onOpenChange={setOpen} trigger={<Button><Plus aria-hidden /> New run</Button>}
      title="New depreciation run" description="One run per month, in sequence. The draft computes depreciation for every capitalized asset; nothing posts until you post it."
      submitLabel="Create draft run" pending={create.isPending} error={create.error} disabled={!/^\d{4}-\d{2}$/.test(month)} onSubmit={() => create.mutate()}>
      <Field id="run-month" label="Month"><Input id="run-month" type="month" className="h-10" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
    </ActionDialog>
  );
}

export function DepreciationView() {
  const { can } = useSession();
  const url = useUrlState();
  const query = useQuery({
    queryKey: ["assets", "runs", url.page],
    queryFn: () => unwrap(api.GET("/api/v1/assets/depreciation-runs/", { params: { query: { page: url.page } } })),
  });
  const columns: Column<DepreciationRun>[] = [
    { key: "period", header: "Month", cell: (r) => monthLabel(r.period) },
    { key: "status", header: "Status", cell: (r) => <StateBadge kind="run" value={r.status} /> },
    { key: "assets", header: "Assets", align: "right", className: "hidden sm:table-cell", cell: (r) => <span className="num">{r.asset_count}</span> },
    { key: "amount", header: "Depreciation", align: "right", cell: (r) => <span className="num">{r.status === "draft" ? "—" : money(r.total_amount)}</span> },
    { key: "posted", header: "Posted", className: "hidden md:table-cell", cell: (r) => <span className="text-muted-foreground">{r.posted_at ? dateTime(r.posted_at) : "—"}</span> },
  ];
  return (
    <>
      <PageHeader title="Depreciation" description="Monthly runs post one balanced journal: depreciation expense against accumulated depreciation."
        actions={can("assets.depreciation_run.create") && <NewRun />} />
      <Section>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(r) => `/assets/depreciation/${r.id}`}
          empty={<EmptyState icon={LineChart} title="No depreciation runs yet" description="Create a run for the month after assets are capitalized." />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
