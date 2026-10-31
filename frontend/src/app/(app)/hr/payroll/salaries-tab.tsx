"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, ShieldCheck, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { Section } from "@/components/erp/page-header";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Amount } from "@/components/people/amount";
import { EmployeePicker } from "@/components/people/employee-picker";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import {
  SENSITIVE_QUERY, errorText, isMoney, sumMoney, today, useSalaryComponents, useSalaryStructures, type EmployeeSalary, type SalaryStructure,
} from "@/lib/api/people";
import { date, money } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

/** Fixed components of a structure, with the structure's default monthly amount. */
function useFixedLines(structure: SalaryStructure | undefined) {
  const components = useSalaryComponents();
  const byId = new Map((components.data?.results ?? []).map((c) => [c.id, c]));
  return (structure?.lines ?? [])
    .map((l) => ({ line: l, component: byId.get(l.component) }))
    .filter((x) => x.component && (x.component.calculation === "fixed" || !x.component.calculation));
}

function AmountsEditor({ structure, amounts, onChange }: {
  structure: SalaryStructure | undefined;
  amounts: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const fixed = useFixedLines(structure);
  if (!structure) return null;
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Monthly amounts</legend>
      <p className="text-xs text-muted-foreground">Percentage components (such as statutory deductions) are calculated at payroll time from their current rates.</p>
      {fixed.map(({ line, component }) => (
        <div key={line.component} className="grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-3">
          <label htmlFor={`amt-${line.component}`} className="text-sm">{component!.name} <span className="text-muted-foreground">({component!.code}){component!.is_basic ? " · basic" : ""}</span></label>
          <Input id={`amt-${line.component}`} inputMode="decimal" className="num text-right" value={amounts[line.component] ?? ""}
            placeholder={line.amount ?? "0.00"} onChange={(e) => onChange({ ...amounts, [line.component]: e.target.value })}
            aria-invalid={Boolean(amounts[line.component]) && !isMoney(amounts[line.component])} />
        </div>
      ))}
      <p className="text-right text-sm text-muted-foreground">Fixed monthly total <span className="num font-medium text-foreground">{money(sumMoney(fixed.map(({ line }) => amounts[line.component] || line.amount)))}</span></p>
    </fieldset>
  );
}

function linesFrom(amounts: Record<string, string>) {
  return Object.entries(amounts).filter(([, v]) => v.trim() !== "").map(([component, amount]) => ({ component, amount: amount.trim() }));
}

function AssignSalary() {
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const structures = useSalaryStructures();
  const [open, setOpen] = useState(false);
  const [employee, setEmployee] = useState("");
  const [structureId, setStructureId] = useState("");
  const [from, setFrom] = useState(today);
  const [notes, setNotes] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const structure = structures.data?.results.find((s) => s.id === structureId);
  const invalid = Object.values(amounts).some((v) => v.trim() !== "" && !isMoney(v));
  const assign = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/hr/salaries/", {
      body: { employee, structure: structureId, effective_from: from, notes, lines: linesFrom(amounts) },
    }))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", "salaries"] });
      setOpen(false);
      setEmployee(""); setAmounts({}); setNotes("");
      toast("Salary assigned");
    },
  });
  const errors = isApiError(assign.error) ? assign.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus aria-hidden /> Assign salary</Button></DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); assign.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Assign a salary</DialogTitle>
            <DialogDescription>Takes effect from the date given. To change pay later, assign a new salary with a later date.</DialogDescription>
          </DialogHeader>
          <FormError message={assign.error && !isApiError(assign.error, "validation_error") ? errorText(assign.error) : (errors.lines ?? errors._form)} />
          <Field id="sal-employee" label="Employee" error={errors.employee}><EmployeePicker id="sal-employee" value={employee} onChange={setEmployee} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="sal-structure" label="Structure" error={errors.structure}>
              <Select value={structureId} onValueChange={(v) => { setStructureId(v); setAmounts({}); }}>
                <SelectTrigger id="sal-structure" className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
                <SelectContent>{structures.data?.results.filter((s) => s.is_active).map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field id="sal-from" label="Effective from" error={errors.effective_from}><Input id="sal-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></Field>
          </div>
          <AmountsEditor structure={structure} amounts={amounts} onChange={setAmounts} />
          <Field id="sal-notes" label="Notes" error={errors.notes}><Input id="sal-notes" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} /></Field>
          <DialogFooter><Button type="submit" disabled={assign.isPending || !employee || !structureId || invalid}>Assign salary</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditSalary({ salary }: { salary: EmployeeSalary }) {
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const structures = useSalaryStructures();
  const [open, setOpen] = useState(false);
  const initial = () => Object.fromEntries(salary.lines.map((l) => [l.component, l.amount]));
  const [amounts, setAmounts] = useState<Record<string, string>>(initial);
  const [notes, setNotes] = useState(salary.notes ?? "");
  const structure = structures.data?.results.find((s) => s.id === salary.structure);
  const invalid = Object.values(amounts).some((v) => v.trim() !== "" && !isMoney(v));
  const save = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.PATCH("/api/v1/hr/salaries/{id}/", {
      params: { path: { id: salary.id } },
      body: { lines: linesFrom(amounts), notes, version: salary.version },
    }))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", "salaries"] });
      setOpen(false);
      toast("Salary updated");
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["people", "salaries"] });
    },
  });
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) { setAmounts(initial()); setNotes(salary.notes ?? ""); save.reset(); } }}>
      <DialogTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`Edit salary of ${salary.employee_code}`}><Pencil aria-hidden /></Button></DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Salary of {salary.employee_code}</DialogTitle>
            <DialogDescription>From {date(salary.effective_from)}. A salary already used in a submitted payroll can&apos;t change; assign a new one instead.</DialogDescription>
          </DialogHeader>
          <FormError message={save.error ? errorText(save.error) : undefined} />
          <AmountsEditor structure={structure} amounts={amounts} onChange={setAmounts} />
          <Field id="sal-edit-notes" label="Notes"><Input id="sal-edit-notes" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} /></Field>
          <DialogFooter><Button type="submit" disabled={save.isPending || invalid}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Employee salaries: MFA-protected. The list is fetched through the step-up flow and never cached. */
export function SalariesTab() {
  const { can } = useSession();
  const { withStepUp } = useStepUp();
  const structures = useSalaryStructures();
  const url = useUrlState();
  const employee = url.get("employee");
  const query = useQuery({
    queryKey: ["people", "salaries", employee, url.page],
    queryFn: () => withStepUp(() => unwrap(api.GET("/api/v1/hr/salaries/", { params: { query: { employee: employee || undefined, page: url.page } } }))),
    retry: false,
    refetchOnWindowFocus: false,
    ...SENSITIVE_QUERY,
  });
  const structureName = (id: string) => structures.data?.results.find((s) => s.id === id)?.name ?? "—";
  const columns: Column<EmployeeSalary>[] = [
    { key: "emp", header: "Employee", cell: (s) => s.employee_code },
    { key: "structure", header: "Structure", cell: (s) => structureName(s.structure), className: "hidden sm:table-cell" },
    { key: "from", header: "From", cell: (s) => <span className="num whitespace-nowrap">{date(s.effective_from)}</span> },
    { key: "fixed", header: "Fixed monthly", align: "right", cell: (s) => <Amount value={sumMoney(s.lines.map((l) => l.amount))} currency={s.currency} /> },
    { key: "lines", header: "Lines", cell: (s) => <span className="text-xs text-muted-foreground">{s.lines.map((l) => l.component_code).join(", ")}</span>, className: "hidden lg:table-cell" },
    { key: "edit", header: <span className="sr-only">Edit</span>, align: "right", cell: (s) => (can("hr.salary.update") ? <EditSalary key={s.version} salary={s} /> : null) },
  ];
  const needsVerification = isApiError(query.error, "mfa_required");
  return (
    <Section title="Employee salaries" description="Sensitive: every view is audited and needs a recent two-step verification."
      actions={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <EmployeePicker value={employee} onChange={(v) => url.set({ employee: v || null })} placeholder="All employees" allowClear activeOnly={false} className="w-full sm:w-64" />
          {can("hr.salary.create") && <AssignSalary />}
        </div>
      }
    >
      {needsVerification ? (
        <div className="flex flex-col items-start gap-2 px-5 py-8">
          <ShieldCheck className="size-5 text-status-info" aria-hidden />
          <p className="font-medium">Verify it&apos;s you to see salaries</p>
          <p className="text-sm text-muted-foreground">Salary amounts need a two-step verification within the last few minutes.</p>
          <Button size="sm" className="mt-1" onClick={() => query.refetch()}>Verify and show salaries</Button>
        </div>
      ) : query.isLoading ? <RowsSkeleton /> : query.error ? <ErrorState error={query.error} onRetry={query.refetch} /> : (
        <>
          <DataTable columns={columns} rows={query.data?.results} caption="Employee salaries"
            empty={<EmptyState icon={Wallet} title="No salaries assigned" description="Assign a structure and monthly amounts to each employee before computing payroll." />} />
          {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
        </>
      )}
    </Section>
  );
}
