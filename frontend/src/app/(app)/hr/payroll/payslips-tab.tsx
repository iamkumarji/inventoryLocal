"use client";

import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { useState } from "react";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { Amount, DocStatus } from "@/components/people/amount";
import { EmployeePicker } from "@/components/people/employee-picker";
import { PayslipBody } from "@/components/people/payslip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { SENSITIVE_QUERY, periodLabel, trimDecimal, type Payslip } from "@/lib/api/people";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

/** Payslips of a run (or all visible), with a detail dialog. Amounts may be restricted. */
export function PayslipTable({ run, employee, page = 1, onPage }: { run?: string; employee?: string; page?: number; onPage?: (page: number) => void }) {
  const [open, setOpen] = useState<Payslip | null>(null);
  const query = useQuery({
    queryKey: ["people", "payslips", run ?? "", employee ?? "", page],
    queryFn: () => unwrap(api.GET("/api/v1/hr/payslips/", { params: { query: { run: run || undefined, employee: employee || undefined, page } } })),
    ...SENSITIVE_QUERY,
  });
  const columns: Column<Payslip>[] = [
    {
      key: "emp", header: "Employee", cell: (p) => (
        <button type="button" className="text-left font-medium underline-offset-4 hover:underline" onClick={() => setOpen(p)}>
          <span className="block">{p.employee_name}</span>
          <span className="block text-xs font-normal text-muted-foreground">{p.employee_code} · {p.period}</span>
        </button>
      ),
    },
    { key: "status", header: "Run", cell: (p) => <DocStatus status={p.status} />, className: "hidden md:table-cell" },
    { key: "paid", header: "Paid days", align: "right", cell: (p) => <span className="num">{trimDecimal(p.paid_days)}</span>, className: "hidden sm:table-cell" },
    { key: "lop", header: "LOP", align: "right", cell: (p) => <span className="num">{trimDecimal(p.lop_days)}</span>, className: "hidden sm:table-cell" },
    { key: "gross", header: "Gross", align: "right", cell: (p) => <Amount value={p.gross} />, className: "hidden md:table-cell" },
    { key: "net", header: "Net pay", align: "right", cell: (p) => <Amount value={p.net_pay} /> },
  ];
  return (
    <>
      <DataTable columns={columns} rows={query.data?.results as Payslip[] | undefined} isLoading={query.isLoading} error={query.error} onRetry={query.refetch} caption="Payslips"
        empty={<EmptyState icon={Receipt} title="No payslips" description={run ? "Compute the run to produce payslips." : "Payslips appear once a payroll run is computed."} />} />
      {query.data && onPage && <PageNav page={page} count={query.data.count} pageSize={50} onPage={onPage} />}
      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
          {open && (
            <>
              <DialogHeader>
                <DialogTitle>{open.employee_name}, {open.period}</DialogTitle>
                <DialogDescription>{open.employee_code} · run {open.status}</DialogDescription>
              </DialogHeader>
              <PayslipBody slip={open} />
              <Button variant="outline" className="justify-self-end" onClick={() => setOpen(null)}>Close</Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function PayslipsTab() {
  const { can } = useSession();
  const url = useUrlState();
  const run = url.get("run");
  const employee = url.get("employee");
  const runs = useQuery({
    queryKey: ["people", "payroll-runs", "options"],
    queryFn: () => unwrap(api.GET("/api/v1/hr/payroll-runs/", { params: { query: { page_size: 36 } } })),
    enabled: can("hr.payroll_run.read"),
    ...SENSITIVE_QUERY,
  });
  return (
    <Section
      title="Payslips"
      description="Amounts are visible only to people who can read salaries."
      actions={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {can("hr.payroll_run.read") && (
            <Select value={run || "all"} onValueChange={(v) => url.set({ run: v === "all" ? null : v })}>
              <SelectTrigger className="w-44" aria-label="Payroll run"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All runs</SelectItem>
                {runs.data?.results.map((r) => <SelectItem key={r.id} value={r.id}>{periodLabel(r.year, r.month)}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {can("hr.employee.read") && <EmployeePicker value={employee} onChange={(v) => url.set({ employee: v || null })} placeholder="All employees" allowClear activeOnly={false} className="w-full sm:w-64" />}
        </div>
      }
    >
      <PayslipTable run={run} employee={employee} page={url.page} onPage={(page) => url.set({ page })} />
    </Section>
  );
}
