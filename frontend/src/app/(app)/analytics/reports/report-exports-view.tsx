"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge, type Tone } from "@/components/erp/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { ActionError } from "@/components/finance/action-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, type Problem } from "@/lib/api/errors";
import { type ReportJob, type ReportType, fiscalYearStart, today } from "@/lib/api/finance";
import type { components } from "@/lib/api/schema";
import { ago, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const PARAM_LABEL: Record<string, string> = { date_from: "From", date_to: "To", as_of: "As of" };
const STATUS: Record<ReportJob["status"], { tone: Tone; label: string }> = {
  queued: { tone: "pending", label: "Queued" }, running: { tone: "info", label: "Running" },
  done: { tone: "approved", label: "Ready" }, failed: { tone: "rejected", label: "Failed" },
};
const defaults = (): Record<string, string> => ({ date_from: fiscalYearStart(), date_to: today(), as_of: today() });

async function download(job: ReportJob) {
  const { data, error, response } = await api.GET("/api/v1/analytics/reports/{id}/download/", { params: { path: { id: job.id } }, parseAs: "blob" });
  if (!response.ok || !data) throw new ApiError(response.status, error as unknown as Partial<Problem>);
  const match = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "");
  const href = URL.createObjectURL(data as Blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = match?.[1] ?? `${job.report_type}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export function ReportExportsView() {
  const { can } = useSession();
  const url = useUrlState();
  const queryClient = useQueryClient();
  const types = useQuery({
    queryKey: ["analytics", "report-types"],
    queryFn: async () => ((await unwrap(api.GET("/api/v1/analytics/report-types/"))) as unknown as { report_types: ReportType[] }).report_types,
  });
  const jobs = useQuery({
    queryKey: ["analytics", "report-jobs", url.page],
    queryFn: () => unwrap(api.GET("/api/v1/analytics/reports/", { params: { query: { page: url.page } } })),
    refetchInterval: (query) => (query.state.data?.results.some((j) => j.status === "queued" || j.status === "running") ? 2000 : false),
  });
  const [type, setType] = useState("");
  const [params, setParams] = useState<Record<string, string>>(defaults);
  const selected = types.data?.find((t) => t.code === type);
  const label = (code: string) => types.data?.find((t) => t.code === code)?.label ?? code.replace(/_/g, " ");

  const request = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/analytics/reports/", {
      body: { report_type: type as components["schemas"]["ReportTypeEnum"], params: Object.fromEntries((selected?.params ?? []).map((p) => [p, params[p]])) },
    })),
    onSuccess: (job) => { toast(`${label(job.report_type)} queued`); url.set({ page: null }); queryClient.invalidateQueries({ queryKey: ["analytics", "report-jobs"] }); },
  });
  const fetchFile = useMutation({ mutationFn: download });

  const columns: Column<ReportJob>[] = [
    { key: "type", header: "Report", cell: (j) => <span className="font-medium">{label(j.report_type)}</span> },
    { key: "params", header: "Parameters", cell: (j) => <span className="num text-muted-foreground">{Object.entries((j.params ?? {}) as Record<string, string>).map(([k, v]) => `${PARAM_LABEL[k] ?? k} ${v}`).join(" · ")}</span> },
    {
      key: "status", header: "Status", cell: (j) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone={STATUS[j.status].tone}>{(j.status === "queued" || j.status === "running") && <Loader2 className="size-3 animate-spin" aria-hidden />}{STATUS[j.status].label}</StatusBadge>
          {j.status === "done" && <span className="num text-xs text-muted-foreground">{j.row_count} rows</span>}
          {j.status === "failed" && <span className="text-xs text-status-rejected">{j.error}</span>}
        </span>
      ),
    },
    { key: "requested", header: "Requested", cell: (j) => <span className="whitespace-nowrap text-muted-foreground" title={dateTime(j.created_at)}>{ago(j.created_at)}</span> },
    { key: "expires", header: "Available until", cell: (j) => <span className="whitespace-nowrap text-muted-foreground">{dateTime(j.expires_at)}</span> },
    {
      key: "download", header: <span className="sr-only">Download</span>, align: "right", cell: (j) => j.status === "done" && (
        <Button size="sm" variant="outline" onClick={() => fetchFile.mutate(j)} disabled={fetchFile.isPending}><Download aria-hidden /> Download CSV</Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Report exports" description="Large reports are generated in the background. Only you can download your exports, for seven days, and only while you still have the access they need." />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
        {can("analytics.report.create") && (
          <Section title="Request an export" description="Only reports you're allowed to export are listed.">
            {types.error ? <ErrorState error={types.error} onRetry={types.refetch} /> : !types.data ? <RowsSkeleton rows={2} /> :
              types.data.length === 0 ? <EmptyState icon={FileSpreadsheet} title="No reports available to you" description="Exports need the export permission of the module the data comes from." /> : (
                <form className="grid gap-4 px-5 py-4" onSubmit={(e) => { e.preventDefault(); request.mutate(); }}>
                  <div className="flex flex-wrap items-end gap-4">
                    <Field id="report-type" label="Report" className="w-full sm:w-64">
                      <Select value={type} onValueChange={setType}>
                        <SelectTrigger id="report-type" className="w-full"><SelectValue placeholder="Choose a report" /></SelectTrigger>
                        <SelectContent>{types.data.map((t) => <SelectItem key={t.code} value={t.code}>{t.label}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                    {selected?.params.map((p) => (
                      <Field key={p} id={`param-${p}`} label={PARAM_LABEL[p] ?? p}>
                        <Input id={`param-${p}`} type="date" className="h-9 w-[9.5rem]" value={params[p] ?? ""} required onChange={(e) => setParams({ ...params, [p]: e.target.value })} />
                      </Field>
                    ))}
                    <Button type="submit" disabled={!selected || request.isPending}>Request export</Button>
                  </div>
                  <ActionError error={request.error} />
                </form>
              )}
          </Section>
        )}
        <Section title="Your exports">
          <ActionError error={fetchFile.error} className="mx-5 mt-4" />
          <DataTable columns={columns} rows={jobs.data?.results} isLoading={jobs.isLoading} error={jobs.error} onRetry={jobs.refetch} caption="Your report exports"
            empty={<EmptyState icon={FileSpreadsheet} title="No exports yet" description="Request one above; it appears here and updates when it's ready." />} />
          {jobs.data && <PageNav page={url.page} count={jobs.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
        </Section>
      </div>
    </>
  );
}
