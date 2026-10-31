"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { DocStatus } from "@/components/people/amount";
import { Facts } from "@/components/people/actions";
import { EMPTY_EMPLOYEE, EmployeeFields, employeeBody, type EmployeeDraft } from "@/components/people/employee-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { errorText, today, type Employee } from "@/lib/api/people";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

function toDraft(e: Employee): EmployeeDraft {
  return {
    ...EMPTY_EMPLOYEE,
    code: e.code,
    full_name: e.full_name,
    department: e.department,
    branch: e.branch ?? "",
    designation: e.designation,
    grade: e.grade,
    date_of_joining: e.date_of_joining,
    work_email: e.work_email,
    phone: e.phone,
    bank_ifsc: e.bank_ifsc,
  };
}

function ExitEmployee({ employee }: { employee: Employee }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [exitDate, setExitDate] = useState(today);
  const exit = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/hr/employees/{id}/exit/", {
      params: { path: { id: employee.id } },
      body: { date_of_exit: exitDate, version: employee.version },
    })),
    onSuccess: (data) => {
      queryClient.setQueryData(["people", "employee", employee.id], data);
      queryClient.invalidateQueries({ queryKey: ["people", "employees"] });
      setOpen(false);
      toast(`${employee.full_name} marked as exited`);
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["people", "employee", employee.id] });
    },
  });
  const errors = isApiError(exit.error) ? exit.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline" size="sm"><LogOut aria-hidden /> Record exit</Button></DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); exit.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Record exit</DialogTitle>
            <DialogDescription>Payroll stops after the last working day. The record can&apos;t be edited afterwards.</DialogDescription>
          </DialogHeader>
          <FormError message={exit.error && !errors.date_of_exit ? errorText(exit.error) : undefined} />
          <Field id="date_of_exit" label="Last working day" error={errors.date_of_exit}>
            <Input id="date_of_exit" type="date" value={exitDate} min={employee.date_of_joining} onChange={(e) => setExitDate(e.target.value)} required />
          </Field>
          <DialogFooter><Button type="submit" variant="destructive" disabled={exit.isPending}>Record exit</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const employee = useQuery({
    queryKey: ["people", "employee", id],
    queryFn: () => unwrap(api.GET("/api/v1/hr/employees/{id}/", { params: { path: { id } } })),
  });
  const [draft, setDraft] = useState<EmployeeDraft>(EMPTY_EMPLOYEE);
  const [syncedVersion, setSyncedVersion] = useState<number | null>(null);
  if (employee.data && employee.data.version !== syncedVersion) {
    setSyncedVersion(employee.data.version);
    setDraft(toDraft(employee.data));
  }
  const save = useMutation({
    mutationFn: () => {
      const { code: _code, ...body } = employeeBody(draft);
      void _code;
      return unwrap(api.PATCH("/api/v1/hr/employees/{id}/", {
        params: { path: { id } },
        body: { ...body, version: employee.data!.version },
      }));
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["people", "employee", id], data);
      queryClient.invalidateQueries({ queryKey: ["people", "employees"] });
      toast("Employee saved");
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["people", "employee", id] });
    },
  });

  if (employee.isLoading) return <PageSkeleton />;
  if (employee.error) return <ErrorState error={employee.error} onRetry={employee.refetch} />;
  const e = employee.data!;
  const editable = can("hr.employee.update") && e.status === "active";
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Employees", href: "/hr/employees" }, { label: e.code }]}
        title={e.full_name}
        meta={<><DocStatus status={e.status} /><span className="text-muted-foreground">{e.code} · {e.department_name}</span></>}
        actions={editable && <ExitEmployee employee={e} />}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Section title="Record" description={editable ? "Changes are audited. Sensitive numbers are replaced, never shown." : undefined}>
          <form className="grid gap-4 px-5 py-4" onSubmit={(ev) => { ev.preventDefault(); save.mutate(); }}>
            <FormError message={save.error && !isApiError(save.error, "validation_error") ? errorText(save.error) : undefined} />
            <EmployeeFields value={draft} onChange={setDraft} errors={errors} mode="edit" linkedUserId={e.user}
              masked={{ pan: e.pan_masked, bank: e.bank_account_masked, aadhaar: e.aadhaar_masked }} disabled={!editable} />
            {editable && <Button type="submit" disabled={save.isPending} className="justify-self-start">Save changes</Button>}
          </form>
        </Section>
        <Section title="On file">
          <Facts items={[
            ["PAN", e.pan_masked || "Not on file"],
            ["Bank account", e.bank_account_masked ? `${e.bank_account_masked}${e.bank_ifsc ? ` · ${e.bank_ifsc}` : ""}` : "Not on file"],
            ["Aadhaar", e.aadhaar_masked || "Not on file"],
            ["Joined", date(e.date_of_joining)],
            ["Exited", e.date_of_exit ? date(e.date_of_exit) : "—"],
            ["Sign-in account", e.user ? "Linked" : "None"],
            ["Created", dateTime(e.created_at)],
          ]} />
        </Section>
      </div>
    </>
  );
}
