"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, FileUp, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { RowErrorList } from "@/components/people/actions";
import { DocStatus } from "@/components/people/amount";
import { EmployeePicker } from "@/components/people/employee-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { errorText, humanize, monthRange, rowErrors, today, type Attendance } from "@/lib/api/people";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type Status = Attendance["status"];
const MANUAL_STATUSES: Status[] = ["present", "half_day", "absent", "holiday"];
const SAMPLE = "employee_code,date,status,check_in,check_out,remarks\nE001,2026-10-01,present,09:00,17:30,\nE001,2026-10-02,holiday,,,Weekly off";

function RecordAttendance() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employee: "", date: today(), status: "present" as Status, check_in: "", check_out: "", remarks: "" });
  const save = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/hr/attendance/", {
      body: {
        employee: form.employee,
        date: form.date,
        status: form.status,
        check_in: form.check_in || null,
        check_out: form.check_out || null,
        remarks: form.remarks,
      },
    })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", "attendance"] });
      setOpen(false);
      toast("Attendance saved");
    },
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  const timed = form.status === "present" || form.status === "half_day";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline"><Plus aria-hidden /> Record a day</Button></DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Record attendance</DialogTitle>
            <DialogDescription>Creates the day or corrects it. Leave days come from approved leave requests.</DialogDescription>
          </DialogHeader>
          <FormError message={save.error && Object.keys(errors).length === 0 ? errorText(save.error) : errors._form} />
          <Field id="att-employee" label="Employee" error={errors.employee}>
            <EmployeePicker id="att-employee" value={form.employee} onChange={(employee) => setForm({ ...form, employee })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="att-date" label="Date" error={errors.date}><Input id="att-date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></Field>
            <Field id="att-status" label="Status" error={errors.status}>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as Status, ...(v === "present" || v === "half_day" ? {} : { check_in: "", check_out: "" }) })}>
                <SelectTrigger id="att-status" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{MANUAL_STATUSES.map((s) => <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            {timed && (
              <>
                <Field id="att-in" label="Check-in" error={errors.check_in}><Input id="att-in" type="time" value={form.check_in} onChange={(e) => setForm({ ...form, check_in: e.target.value })} /></Field>
                <Field id="att-out" label="Check-out" error={errors.check_out}><Input id="att-out" type="time" value={form.check_out} onChange={(e) => setForm({ ...form, check_out: e.target.value })} /></Field>
              </>
            )}
          </div>
          <Field id="att-remarks" label="Remarks" error={errors.remarks}><Input id="att-remarks" value={form.remarks} maxLength={300} onChange={(e) => setForm({ ...form, remarks: e.target.value })} /></Field>
          <DialogFooter><Button type="submit" disabled={save.isPending || !form.employee}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportAttendance() {
  const { activeCompany } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const run = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/hr/attendance/import/", {
      body: { csv, overwrite, company: activeCompany?.id },
    })),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["people", "attendance"] });
      toast(`Imported ${result.rows} row(s): ${result.created} new, ${result.updated} updated`);
      setOpen(false);
      setCsv("");
    },
  });
  const rows = rowErrors(run.error);
  const fieldErrors = isApiError(run.error) ? run.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) run.reset(); }}>
      <DialogTrigger asChild><Button><FileUp aria-hidden /> Import CSV</Button></DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Import attendance</DialogTitle>
            <DialogDescription>
              All or nothing: if any row has a problem, nothing is imported and every problem is listed. Columns:{" "}
              <code className="text-xs">employee_code,date,status[,check_in,check_out,remarks]</code>. Row 1 is the header.
            </DialogDescription>
          </DialogHeader>
          {run.error && rows.length === 0 && <FormError message={fieldErrors.csv ?? errorText(run.error)} />}
          {rows.length > 0 && (
            <div className="grid gap-2">
              <p className="text-sm font-medium text-status-rejected">{isApiError(run.error) ? run.error.problem.detail : ""}</p>
              <RowErrorList errors={rows} />
            </div>
          )}
          <Field id="csv-file" label="CSV file" hint="Or paste the rows below.">
            <Input id="csv-file" type="file" accept=".csv,text/csv,text/plain"
              onChange={async (e) => { const file = e.target.files?.[0]; if (file) setCsv(await file.text()); }} />
          </Field>
          <Field id="csv-text" label="Rows">
            <Textarea id="csv-text" value={csv} onChange={(e) => setCsv(e.target.value)} rows={8} placeholder={SAMPLE} className="num max-h-64 font-mono text-xs" spellCheck={false} />
          </Field>
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
            <Label htmlFor="csv-overwrite" className="font-normal">Replace days that are already recorded</Label>
            <Switch id="csv-overwrite" checked={overwrite} onCheckedChange={setOverwrite} />
          </div>
          <DialogFooter><Button type="submit" disabled={run.isPending || !csv.trim()}>Import</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function currentPeriod() {
  return today().slice(0, 7);
}

export function AttendanceView() {
  const { can } = useSession();
  const url = useUrlState();
  const period = url.get("period") || currentPeriod();
  const employee = url.get("employee");
  const status = url.get("status");
  const range = monthRange(period);
  const query = useQuery({
    queryKey: ["people", "attendance", period, employee, status, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/hr/attendance/", {
      params: { query: { date__gte: range?.from, date__lte: range?.to, employee: employee || undefined, status: (status || undefined) as Status | undefined, page: url.page } },
    })),
  });
  const columns: Column<Attendance>[] = [
    { key: "date", header: "Date", cell: (r) => <span className="num whitespace-nowrap">{date(r.date)}</span> },
    { key: "emp", header: "Employee", cell: (r) => r.employee_code },
    { key: "status", header: "Status", cell: (r) => <DocStatus status={r.status} /> },
    { key: "times", header: "In / out", cell: (r) => <span className="num text-muted-foreground">{r.check_in ? `${r.check_in.slice(0, 5)}–${r.check_out?.slice(0, 5) ?? ""}` : "—"}</span>, className: "hidden sm:table-cell" },
    { key: "source", header: "Source", cell: (r) => <span className="text-muted-foreground">{humanize(r.source)}</span>, className: "hidden md:table-cell" },
    { key: "remarks", header: "Remarks", cell: (r) => <span className="block max-w-[32ch] truncate text-muted-foreground">{r.remarks || "—"}</span>, className: "hidden lg:table-cell" },
  ];
  return (
    <>
      <PageHeader title="Attendance" description="Daily records by period. Payroll pays present days, paid leave and holidays."
        actions={can("hr.attendance.create") && <><RecordAttendance /><ImportAttendance /></>} />
      <Section
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Input type="month" value={period} onChange={(e) => url.set({ period: e.target.value || null })} className="h-9 w-40" aria-label="Period" />
            <EmployeePicker value={employee} onChange={(v) => url.set({ employee: v || null })} placeholder="All employees" allowClear activeOnly={false} className="w-full sm:w-64" />
            <Select value={status || "all"} onValueChange={(v) => url.set({ status: v === "all" ? null : v })}>
              <SelectTrigger className="w-32" aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any status</SelectItem>
                {(["present", "half_day", "absent", "leave", "holiday"] as const).map((s) => <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        }
      >
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch} caption="Attendance records"
          empty={<EmptyState icon={CalendarDays} title="No attendance recorded for this period" description={can("hr.attendance.create") ? "Record days one by one or import a CSV from your time clock." : undefined} />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
