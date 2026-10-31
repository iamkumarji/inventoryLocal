"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Landmark, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { Amount, DocStatus } from "@/components/people/amount";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { MONTHS, SENSITIVE_QUERY, errorText, periodLabel, type PayrollRun } from "@/lib/api/people";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

function NewRun() {
  const { activeCompany } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const now = new Date();
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/hr/payroll-runs/", {
      body: { company: activeCompany?.id ?? "", year: Number(year), month: Number(month) },
    })),
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ["people", "payroll-runs"] });
      toast(`Payroll ${run.number} created`);
      router.push(`/hr/payroll-runs/${run.id}`);
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus aria-hidden /> New payroll run</Button></DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <DialogHeader>
            <DialogTitle>New payroll run</DialogTitle>
            <DialogDescription>One run per month for {activeCompany?.name ?? "the active company"}. Compute it once attendance is complete.</DialogDescription>
          </DialogHeader>
          <FormError message={create.error && !isApiError(create.error, "validation_error") ? errorText(create.error) : (errors._form ?? errors.company)} />
          <div className="grid grid-cols-2 gap-4">
            <Field id="run-month" label="Month" error={errors.month}>
              <Select value={month} onValueChange={setMonth}>
                <SelectTrigger id="run-month" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field id="run-year" label="Year" error={errors.year}><Input id="run-year" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} required /></Field>
          </div>
          <DialogFooter><Button type="submit" disabled={create.isPending}>Create run</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RunsTab() {
  const { can } = useSession();
  const url = useUrlState();
  const status = url.get("status");
  const query = useQuery({
    queryKey: ["people", "payroll-runs", status, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/hr/payroll-runs/", { params: { query: { status: status || undefined, page: url.page } } })),
    ...SENSITIVE_QUERY,
  });
  const columns: Column<PayrollRun>[] = [
    { key: "period", header: "Period", cell: (r) => <span><span className="block">{periodLabel(r.year, r.month)}</span><span className="block text-xs font-normal text-muted-foreground">{r.number}</span></span> },
    { key: "status", header: "Status", cell: (r) => <DocStatus status={r.status} /> },
    { key: "count", header: "Employees", align: "right", cell: (r) => <span className="num">{r.employee_count}</span>, className: "hidden sm:table-cell" },
    { key: "gross", header: "Gross", align: "right", cell: (r) => <Amount value={r.gross_total} currency={r.currency} />, className: "hidden md:table-cell" },
    { key: "net", header: "Net pay", align: "right", cell: (r) => <Amount value={r.net_total} currency={r.currency} /> },
  ];
  return (
    <Section
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select value={status || "all"} onValueChange={(v) => url.set({ status: v === "all" ? null : v })}>
            <SelectTrigger className="w-36" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              {["draft", "computed", "submitted", "approved", "rejected", "posted"].map((s) => <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>)}
            </SelectContent>
          </Select>
          {can("hr.payroll_run.create") && <NewRun />}
        </div>
      }
    >
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
        rowHref={(r) => `/hr/payroll-runs/${r.id}`} caption="Payroll runs"
        empty={<EmptyState icon={Landmark} title="No payroll runs yet" description="Create a run for a month, compute it, and send it for approval." />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
    </Section>
  );
}
