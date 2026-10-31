"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { DecideDialog, TabStrip } from "@/components/people/actions";
import { DocStatus } from "@/components/people/amount";
import { EmployeePicker } from "@/components/people/employee-picker";
import { CancelLeave, SubmitLeave, canCancelLeave } from "@/components/people/leave-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { errorText, today, trimDecimal, useLeaveTypes, useMyEmployee, withVersion, type LeaveBalance, type LeaveRequest, type LeaveType } from "@/lib/api/people";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

function useTypeName() {
  const types = useLeaveTypes();
  const byId = new Map((types.data?.results ?? []).map((t) => [t.id, t]));
  return (id: string) => byId.get(id)?.name ?? "—";
}

/** Approve/reject a submitted request. The employee can never decide their own leave. */
export function DecideLeave({ request }: { request: LeaveRequest }) {
  const queryClient = useQueryClient();
  const mine = useMyEmployee();
  const decide = useMutation({
    mutationFn: ({ approve, comment }: { approve: boolean; comment: string }) =>
      unwrap(api.POST("/api/v1/hr/leave-requests/{id}/decide/", {
        params: { path: { id: request.id } },
        body: { approve, comment, version: request.version },
      })),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      toast(data.status === "approved" ? "Leave approved" : "Leave rejected");
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["people"] });
    },
  });
  const own = Boolean(mine.data && mine.data.id === request.employee);
  return (
    <DecideDialog
      title={`Leave for ${request.employee_name}`}
      description={`${date(request.from_date)} to ${date(request.to_date)} · ${trimDecimal(request.days)} day(s)${request.reason ? ` · “${request.reason}”` : ""}`}
      blockedReason={own ? "This is your own leave request. Someone else must decide it." : undefined}
      pending={decide.isPending}
      error={decide.error}
      onDecide={(approve, comment) => decide.mutateAsync({ approve, comment })}
    />
  );
}

export function LeaveRowActions({ request }: { request: LeaveRequest }) {
  const { can } = useSession();
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {request.status === "draft" && can("hr.leave_request.update") && <SubmitLeave request={request} />}
      {request.status === "submitted" && (can("hr.leave_request.approve") || can("hr.leave_request.reject")) && <DecideLeave request={request} />}
      {canCancelLeave(request) && can("hr.leave_request.cancel") && <CancelLeave request={request} />}
    </div>
  );
}

function NewRequest() {
  const queryClient = useQueryClient();
  const types = useLeaveTypes();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employee: "", leave_type: "", from_date: today(), to_date: today(), reason: "", submit: true });
  const create = useMutation({
    mutationFn: async () => {
      const draft = await unwrap(api.POST("/api/v1/hr/leave-requests/", {
        body: { employee: form.employee, leave_type: form.leave_type, from_date: form.from_date, to_date: form.to_date, reason: form.reason },
      }));
      if (!form.submit) return draft;
      return unwrap(api.POST("/api/v1/hr/leave-requests/{id}/submit/", { params: { path: { id: draft.id } }, body: { version: draft.version } }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      setOpen(false);
      toast(form.submit ? "Leave request filed and submitted" : "Leave request saved as draft");
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus aria-hidden /> File leave</Button></DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <DialogHeader>
            <DialogTitle>File leave for an employee</DialogTitle>
            <DialogDescription>Days are calendar days, both ends included. Employees can also apply themselves under My leave.</DialogDescription>
          </DialogHeader>
          <FormError message={create.error && !isApiError(create.error, "validation_error") ? errorText(create.error) : undefined} />
          <Field id="lr-employee" label="Employee" error={errors.employee}>
            <EmployeePicker id="lr-employee" value={form.employee} onChange={(employee) => setForm({ ...form, employee })} />
          </Field>
          <Field id="lr-type" label="Leave type" error={errors.leave_type}>
            <Select value={form.leave_type} onValueChange={(v) => setForm({ ...form, leave_type: v })}>
              <SelectTrigger id="lr-type" className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
              <SelectContent>{types.data?.results.filter((t) => t.is_active).map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="lr-from" label="From" error={errors.from_date}><Input id="lr-from" type="date" value={form.from_date} onChange={(e) => setForm({ ...form, from_date: e.target.value })} required /></Field>
            <Field id="lr-to" label="To" error={errors.to_date}><Input id="lr-to" type="date" value={form.to_date} min={form.from_date} onChange={(e) => setForm({ ...form, to_date: e.target.value })} required /></Field>
          </div>
          <Field id="lr-reason" label="Reason" error={errors.reason}><Input id="lr-reason" value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
            <Label htmlFor="lr-submit" className="font-normal">Submit for approval now</Label>
            <Switch id="lr-submit" checked={form.submit} onCheckedChange={(submit) => setForm({ ...form, submit })} />
          </div>
          <DialogFooter><Button type="submit" disabled={create.isPending || !form.employee || !form.leave_type}>File leave</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Requests() {
  const url = useUrlState();
  const { can } = useSession();
  const typeName = useTypeName();
  const status = url.get("status") || "submitted";
  const employee = url.get("employee");
  const query = useQuery({
    queryKey: ["people", "leave-requests", status, employee, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/hr/leave-requests/", {
      params: { query: { status: status === "any" ? undefined : status, employee: employee || undefined, page: url.page } },
    })),
  });
  const columns: Column<LeaveRequest>[] = [
    { key: "who", header: "Employee", cell: (r) => <span><span className="block">{r.employee_name}</span><span className="block text-xs font-normal text-muted-foreground">{r.employee_code}</span></span> },
    { key: "type", header: "Type", cell: (r) => typeName(r.leave_type), className: "hidden sm:table-cell" },
    { key: "dates", header: "Dates", cell: (r) => <span className="num whitespace-nowrap">{date(r.from_date)} – {date(r.to_date)}</span> },
    { key: "days", header: "Days", align: "right", cell: (r) => <span className="num">{trimDecimal(r.days)}</span> },
    { key: "status", header: "Status", cell: (r) => <DocStatus status={r.status} /> },
    { key: "actions", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => <div className="relative z-10"><LeaveRowActions request={r} /></div> },
  ];
  return (
    <Section
      actions={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Select value={status} onValueChange={(v) => url.set({ status: v === "submitted" ? null : v })}>
            <SelectTrigger className="w-40" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="submitted">Waiting for decision</SelectItem>
              {(["draft", "approved", "rejected", "cancelled"] as const).map((s) => <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>)}
              <SelectItem value="any">Any status</SelectItem>
            </SelectContent>
          </Select>
          {can("hr.employee.read") && (
            <EmployeePicker value={employee} onChange={(v) => url.set({ employee: v || null })} placeholder="All employees" allowClear activeOnly={false} className="w-full sm:w-64" />
          )}
        </div>
      }
    >
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
        rowHref={(r) => `/hr/leave-requests/${r.id}`} caption="Leave requests"
        empty={<EmptyState icon={CalendarDays} title={status === "submitted" ? "No leave is waiting for a decision" : "No leave requests match"} />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
    </Section>
  );
}

function Allocate() {
  const queryClient = useQueryClient();
  const types = useLeaveTypes();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employee: "", leave_type: "", year: today().slice(0, 4), allocated: "" });
  const allocate = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/hr/leave-balances/", {
      body: { employee: form.employee, leave_type: form.leave_type, year: Number(form.year), ...(form.allocated.trim() ? { allocated: form.allocated.trim() } : {}) },
    })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", "leave-balances"] });
      setOpen(false);
      toast("Balance allocated");
    },
  });
  const errors = isApiError(allocate.error) ? allocate.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus aria-hidden /> Allocate</Button></DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); allocate.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Allocate leave</DialogTitle>
            <DialogDescription>Allocating again for the same year replaces the allocation (it can&apos;t go below days already used).</DialogDescription>
          </DialogHeader>
          <FormError message={allocate.error && !isApiError(allocate.error, "validation_error") ? errorText(allocate.error) : errors._form} />
          <Field id="al-employee" label="Employee" error={errors.employee}><EmployeePicker id="al-employee" value={form.employee} onChange={(employee) => setForm({ ...form, employee })} /></Field>
          <Field id="al-type" label="Leave type" error={errors.leave_type}>
            <Select value={form.leave_type} onValueChange={(v) => setForm({ ...form, leave_type: v })}>
              <SelectTrigger id="al-type" className="w-full"><SelectValue placeholder="Choose a paid leave type" /></SelectTrigger>
              <SelectContent>{types.data?.results.filter((t) => t.is_active && t.is_paid).map((t) => <SelectItem key={t.id} value={t.id}>{t.name} ({trimDecimal(t.annual_quota)} days a year)</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="al-year" label="Year" error={errors.year}><Input id="al-year" inputMode="numeric" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} required /></Field>
            <Field id="al-days" label="Days" error={errors.allocated} hint="Blank uses the annual quota"><Input id="al-days" inputMode="decimal" value={form.allocated} onChange={(e) => setForm({ ...form, allocated: e.target.value })} /></Field>
          </div>
          <DialogFooter><Button type="submit" disabled={allocate.isPending || !form.employee || !form.leave_type}>Allocate</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Balances() {
  const url = useUrlState();
  const { can } = useSession();
  const typeName = useTypeName();
  const year = url.get("year") || today().slice(0, 4);
  const employee = url.get("employee");
  const query = useQuery({
    queryKey: ["people", "leave-balances", year, employee, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/hr/leave-balances/", {
      params: { query: { year: Number(year) || undefined, employee: employee || undefined, page: url.page } },
    })),
  });
  const columns: Column<LeaveBalance>[] = [
    { key: "emp", header: "Employee", cell: (b) => b.employee_code },
    { key: "type", header: "Type", cell: (b) => typeName(b.leave_type) },
    { key: "year", header: "Year", cell: (b) => <span className="num">{b.year}</span>, className: "hidden sm:table-cell" },
    { key: "alloc", header: "Allocated", align: "right", cell: (b) => <span className="num">{trimDecimal(b.allocated)}</span>, className: "hidden sm:table-cell" },
    { key: "used", header: "Used", align: "right", cell: (b) => <span className="num">{trimDecimal(b.used)}</span> },
    { key: "avail", header: "Available", align: "right", cell: (b) => <span className="num font-medium">{trimDecimal(b.available)}</span> },
  ];
  return (
    <Section
      actions={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Input value={year} onChange={(e) => url.set({ year: e.target.value || null })} className="h-9 w-24" inputMode="numeric" aria-label="Year" />
          {can("hr.employee.read") && <EmployeePicker value={employee} onChange={(v) => url.set({ employee: v || null })} placeholder="All employees" allowClear activeOnly={false} className="w-full sm:w-64" />}
          {can("hr.leave_balance.create") && <Allocate />}
        </div>
      }
    >
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch} caption="Leave balances"
        empty={<EmptyState icon={CalendarDays} title="No balances for this year" description="Allocate paid leave to employees to let them apply." />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
    </Section>
  );
}

function LeaveTypeDialog({ type }: { type?: LeaveType }) {
  const { activeCompany } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const blank = { code: "", name: "", is_paid: true, annual_quota: "0", is_active: true };
  const [form, setForm] = useState(type ? { code: type.code, name: type.name, is_paid: type.is_paid ?? true, annual_quota: type.annual_quota ?? "0", is_active: type.is_active ?? true } : blank);
  const save = useMutation({
    mutationFn: () => type
      ? unwrap(api.PATCH("/api/v1/hr/leave-types/{id}/", { params: { path: { id: type.id } }, body: withVersion({ name: form.name, annual_quota: form.annual_quota, is_active: form.is_active }, type.version) }))
      : unwrap(api.POST("/api/v1/hr/leave-types/", { body: { ...form, company: activeCompany?.id ?? "" } })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", "leave-types"] });
      setOpen(false);
      toast(type ? "Leave type saved" : "Leave type added");
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["people", "leave-types"] });
    },
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {type ? <Button size="icon-sm" variant="ghost" aria-label={`Edit ${type.name}`}><Pencil aria-hidden /></Button> : <Button size="sm"><Plus aria-hidden /> Leave type</Button>}
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogHeader><DialogTitle>{type ? `Edit ${type.name}` : "Add a leave type"}</DialogTitle></DialogHeader>
          <FormError message={save.error && !isApiError(save.error, "validation_error") ? errorText(save.error) : errors._form} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="lt-code" label="Code" error={errors.code}><Input id="lt-code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} disabled={Boolean(type)} required maxLength={20} /></Field>
            <Field id="lt-name" label="Name" error={errors.name}><Input id="lt-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} /></Field>
            <Field id="lt-quota" label="Days a year" error={errors.annual_quota}><Input id="lt-quota" inputMode="decimal" value={form.annual_quota} onChange={(e) => setForm({ ...form, annual_quota: e.target.value })} /></Field>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
            <Label htmlFor="lt-paid" className="font-normal">Paid leave (counts as paid days)</Label>
            <Switch id="lt-paid" checked={form.is_paid} disabled={Boolean(type)} onCheckedChange={(is_paid) => setForm({ ...form, is_paid })} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
            <Label htmlFor="lt-active" className="font-normal">Active</Label>
            <Switch id="lt-active" checked={form.is_active} onCheckedChange={(is_active) => setForm({ ...form, is_active })} />
          </div>
          <DialogFooter><Button type="submit" disabled={save.isPending}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Types() {
  const { can } = useSession();
  const types = useLeaveTypes();
  const columns: Column<LeaveType>[] = [
    { key: "name", header: "Leave type", cell: (t) => <span><span className="block">{t.name}</span><span className="block text-xs text-muted-foreground">{t.code}</span></span> },
    { key: "paid", header: "Paid", cell: (t) => (t.is_paid ? "Paid" : "Unpaid") },
    { key: "quota", header: "Days a year", align: "right", cell: (t) => <span className="num">{trimDecimal(t.annual_quota)}</span> },
    { key: "active", header: "Status", cell: (t) => <ActiveStatus active={t.is_active ?? true} /> },
    { key: "edit", header: <span className="sr-only">Edit</span>, align: "right", cell: (t) => (can("hr.leave_type.update") ? <LeaveTypeDialog key={t.version} type={t} /> : null) },
  ];
  return (
    <Section actions={can("hr.leave_type.create") && <LeaveTypeDialog />}>
      <DataTable columns={columns} rows={types.data?.results} isLoading={types.isLoading} error={types.error} onRetry={types.refetch} caption="Leave types"
        empty={<EmptyState icon={CalendarDays} title="No leave types yet" description="Add types such as casual, sick and unpaid leave." />} />
    </Section>
  );
}

export function LeaveView() {
  const { can } = useSession();
  const url = useUrlState();
  const tab = url.get("tab") || "requests";
  return (
    <>
      <PageHeader title="Leave" description="Decide requests, allocate balances and set up leave types. Nobody decides their own leave."
        actions={tab === "requests" && can("hr.leave_request.create") && can("hr.employee.read") && <NewRequest />} />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "requests" ? null : v, status: null, employee: null })}>
        <TabStrip>
          <TabsList>
            <TabsTrigger value="requests">Requests</TabsTrigger>
            {can("hr.leave_balance.read") && <TabsTrigger value="balances">Balances</TabsTrigger>}
            {can("hr.leave_type.read") && <TabsTrigger value="types">Leave types</TabsTrigger>}
          </TabsList>
        </TabStrip>
      </Tabs>
      {tab === "requests" && <Requests />}
      {tab === "balances" && <Balances />}
      {tab === "types" && <Types />}
    </>
  );
}
