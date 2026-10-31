"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { DocStatus } from "@/components/people/amount";
import { EMPTY_EMPLOYEE, EmployeeFields, employeeBody, type EmployeeDraft } from "@/components/people/employee-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { errorText, useDepartments, type Employee } from "@/lib/api/people";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

function NewEmployee() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<EmployeeDraft>(EMPTY_EMPLOYEE);
  const create = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/api/v1/hr/employees/", {
        body: employeeBody(draft),
      })),
    onSuccess: (employee) => {
      queryClient.invalidateQueries({ queryKey: ["people", "employees"] });
      setDraft(EMPTY_EMPLOYEE);
      toast(`${employee.full_name} added`);
      router.push(`/hr/employees/${employee.id}`);
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus aria-hidden /> Add employee</Button></DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Add an employee</DialogTitle>
            <DialogDescription>Salary is assigned separately under Payroll by someone allowed to see pay.</DialogDescription>
          </DialogHeader>
          <FormError message={create.error && !isApiError(create.error, "validation_error") ? errorText(create.error) : undefined} />
          <EmployeeFields value={draft} onChange={setDraft} errors={errors} mode="create" />
          <DialogFooter><Button type="submit" disabled={create.isPending || !draft.department}>Add employee</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EmployeesView() {
  const { can } = useSession();
  const url = useUrlState();
  const search = url.get("q");
  const status = url.get("status") || "active";
  const department = url.get("department");
  const [draft, setDraft] = useState(search);
  const departments = useDepartments();
  const query = useQuery({
    queryKey: ["people", "employees", search, status, department, url.page],
    queryFn: () =>
      unwrap(api.GET("/api/v1/hr/employees/", {
        params: { query: { search: search || undefined, status: status === "any" ? undefined : (status as "active" | "exited"), department: department || undefined, page: url.page } },
      })),
  });
  const columns: Column<Employee>[] = [
    { key: "name", header: "Employee", cell: (e) => <span><span className="block">{e.full_name}</span><span className="block text-xs font-normal text-muted-foreground">{e.code}</span></span> },
    { key: "dept", header: "Department", cell: (e) => e.department_name },
    { key: "designation", header: "Designation", cell: (e) => e.designation || "—", className: "hidden md:table-cell" },
    { key: "joined", header: "Joined", cell: (e) => <span className="text-muted-foreground">{date(e.date_of_joining)}</span>, className: "hidden sm:table-cell" },
    { key: "status", header: "Status", cell: (e) => <DocStatus status={e.status} /> },
  ];
  return (
    <>
      <PageHeader title="Employees" description="People on the payroll. Bank and identity numbers are only ever shown masked."
        actions={can("hr.employee.create") && <NewEmployee />} />
      <Section
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <form onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }} className="relative min-w-0 flex-1 sm:flex-none">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Code, name or designation" className="h-9 w-full pl-8 sm:w-56" aria-label="Search employees" />
            </form>
            <Select value={department || "all"} onValueChange={(v) => url.set({ department: v === "all" ? null : v })}>
              <SelectTrigger className="w-44" aria-label="Department"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.data?.results.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => url.set({ status: v === "active" ? null : v })}>
              <SelectTrigger className="w-32" aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="exited">Exited</SelectItem>
                <SelectItem value="any">Any status</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(e) => `/hr/employees/${e.id}`} caption="Employees"
          empty={<EmptyState icon={Users} title="No employees match" description={can("hr.employee.create") ? "Add employees and link them to their sign-in accounts for self-service." : undefined} />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
