"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { Amount } from "@/components/people/amount";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { errorText, humanize, moneyInput, trimDecimal, useSalaryComponents, withVersion, type SalaryComponent } from "@/lib/api/people";
import { useSession } from "@/lib/session";

type Kind = SalaryComponent["kind"];
type Calc = NonNullable<SalaryComponent["calculation"]>;

const KINDS: Kind[] = ["earning", "deduction", "employer_contribution"];
const CALCS: Calc[] = ["fixed", "percent_of_basic", "percent_of_gross"];

type Form = {
  code: string; name: string; kind: Kind; calculation: Calc; is_basic: boolean; is_statutory: boolean; prorate: boolean;
  rate_pct: string; wage_ceiling: string; gross_max: string; gross_min: string; expense_key: string; liability_key: string;
  sequence: string; is_active: boolean;
};

function toForm(c?: SalaryComponent): Form {
  return {
    code: c?.code ?? "", name: c?.name ?? "", kind: c?.kind ?? "earning", calculation: c?.calculation ?? "fixed",
    is_basic: c?.is_basic ?? false, is_statutory: c?.is_statutory ?? false, prorate: c?.prorate ?? true,
    rate_pct: moneyInput(c?.rate_pct), wage_ceiling: moneyInput(c?.wage_ceiling), gross_max: moneyInput(c?.gross_max), gross_min: moneyInput(c?.gross_min),
    expense_key: c?.expense_key ?? "", liability_key: c?.liability_key ?? "", sequence: String(c?.sequence ?? 100), is_active: c?.is_active ?? true,
  };
}

const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

function ComponentDialog({ component }: { component?: SalaryComponent }) {
  const { activeCompany } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(() => toForm(component));
  const editable = {
    name: form.name, prorate: form.prorate, rate_pct: orNull(form.rate_pct), wage_ceiling: orNull(form.wage_ceiling),
    gross_max: orNull(form.gross_max), gross_min: orNull(form.gross_min), expense_key: form.expense_key.trim(),
    liability_key: form.liability_key.trim(), sequence: Number(form.sequence) || 100, is_active: form.is_active,
  };
  const save = useMutation({
    mutationFn: () => component
      ? unwrap(api.PATCH("/api/v1/hr/salary-components/{id}/", { params: { path: { id: component.id } }, body: withVersion(editable, component.version) }))
      : unwrap(api.POST("/api/v1/hr/salary-components/", {
        body: { ...editable, company: activeCompany?.id ?? "", code: form.code.trim(), kind: form.kind, calculation: form.calculation, is_basic: form.is_basic, is_statutory: form.is_statutory },
      })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", "salary-components"] });
      setOpen(false);
      toast(component ? "Component saved" : "Component added");
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["people", "salary-components"] });
    },
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  const percent = form.calculation !== "fixed";
  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });
  const toggle = (key: "is_basic" | "is_statutory" | "prorate" | "is_active", label: string, locked = false) => (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <Label htmlFor={`sc-${key}`} className="font-normal">{label}</Label>
      <Switch id={`sc-${key}`} checked={form[key]} disabled={locked} onCheckedChange={(v) => setForm({ ...form, [key]: v })} />
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) { setForm(toForm(component)); save.reset(); } }}>
      <DialogTrigger asChild>
        {component ? <Button size="icon-sm" variant="ghost" aria-label={`Edit ${component.code}`}><Pencil aria-hidden /></Button> : <Button size="sm"><Plus aria-hidden /> Component</Button>}
      </DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogHeader>
            <DialogTitle>{component ? `Edit ${component.code}` : "Add a salary component"}</DialogTitle>
            <DialogDescription>
              Statutory rates, wage ceilings and slab limits are data you maintain here, not code. Check them against the current
              notifications before each payroll.
            </DialogDescription>
          </DialogHeader>
          <FormError message={save.error && !isApiError(save.error, "validation_error") ? errorText(save.error) : errors._form} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="sc-code" label="Code" error={errors.code}><Input id="sc-code" value={form.code} onChange={set("code")} disabled={Boolean(component)} required maxLength={20} /></Field>
            <Field id="sc-name" label="Name" error={errors.name} className="sm:col-span-2"><Input id="sc-name" value={form.name} onChange={set("name")} required maxLength={100} /></Field>
            <Field id="sc-kind" label="Kind" error={errors.kind}>
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v as Kind })} disabled={Boolean(component)}>
                <SelectTrigger id="sc-kind" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{KINDS.map((k) => <SelectItem key={k} value={k}>{humanize(k)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field id="sc-calc" label="Calculation" error={errors.calculation}>
              <Select value={form.calculation} onValueChange={(v) => setForm({ ...form, calculation: v as Calc })} disabled={Boolean(component)}>
                <SelectTrigger id="sc-calc" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{CALCS.map((c) => <SelectItem key={c} value={c}>{humanize(c)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field id="sc-seq" label="Order" error={errors.sequence}><Input id="sc-seq" inputMode="numeric" value={form.sequence} onChange={set("sequence")} /></Field>
            <Field id="sc-rate" label="Rate %" error={errors.rate_pct} hint={percent ? "Required for a percentage" : "Only for percentages"}>
              <Input id="sc-rate" inputMode="decimal" value={form.rate_pct} onChange={set("rate_pct")} disabled={!percent} />
            </Field>
            <Field id="sc-ceiling" label="Wage ceiling" error={errors.wage_ceiling} hint="Caps the percentage base"><Input id="sc-ceiling" inputMode="decimal" value={form.wage_ceiling} onChange={set("wage_ceiling")} disabled={!percent} /></Field>
            <Field id="sc-gmin" label="Applies from gross" error={errors.gross_min}><Input id="sc-gmin" inputMode="decimal" value={form.gross_min} onChange={set("gross_min")} /></Field>
            <Field id="sc-gmax" label="Applies up to gross" error={errors.gross_max}><Input id="sc-gmax" inputMode="decimal" value={form.gross_max} onChange={set("gross_max")} /></Field>
            <Field id="sc-exp" label="Expense GL key" error={errors.expense_key} hint="Blank uses the default"><Input id="sc-exp" value={form.expense_key} onChange={set("expense_key")} maxLength={40} /></Field>
            <Field id="sc-liab" label="Liability GL key" error={errors.liability_key} hint="Blank uses the default"><Input id="sc-liab" value={form.liability_key} onChange={set("liability_key")} maxLength={40} /></Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {toggle("is_basic", "Basic pay (one per structure)", Boolean(component))}
            {toggle("is_statutory", "Statutory", Boolean(component))}
            {toggle("prorate", "Scale with paid days")}
            {toggle("is_active", "Active")}
          </div>
          <DialogFooter><Button type="submit" disabled={save.isPending}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ComponentsTab() {
  const { can } = useSession();
  const components = useSalaryComponents();
  const columns: Column<SalaryComponent>[] = [
    { key: "name", header: "Component", cell: (c) => <span><span className="block">{c.name}</span><span className="block text-xs text-muted-foreground">{c.code}{c.is_basic ? " · basic" : ""}{c.is_statutory ? " · statutory" : ""}</span></span> },
    { key: "kind", header: "Kind", cell: (c) => humanize(c.kind), className: "hidden sm:table-cell" },
    { key: "calc", header: "Calculation", cell: (c) => (c.calculation === "fixed" || !c.calculation ? "Fixed" : <span><span className="num">{trimDecimal(c.rate_pct)}%</span> of {c.calculation === "percent_of_basic" ? "basic" : "gross"}</span>) },
    { key: "ceiling", header: "Ceiling", align: "right", cell: (c) => (c.wage_ceiling ? <Amount value={c.wage_ceiling} /> : "—"), className: "hidden md:table-cell" },
    { key: "slab", header: "Gross range", cell: (c) => (c.gross_min || c.gross_max ? <span className="num text-muted-foreground">{c.gross_min ? trimDecimal(c.gross_min) : "0"} – {c.gross_max ? trimDecimal(c.gross_max) : "∞"}</span> : "—"), className: "hidden lg:table-cell" },
    { key: "active", header: "Status", cell: (c) => <ActiveStatus active={c.is_active ?? true} />, className: "hidden sm:table-cell" },
    { key: "edit", header: <span className="sr-only">Edit</span>, align: "right", cell: (c) => (can("hr.salary_structure.update") ? <ComponentDialog key={c.version} component={c} /> : null) },
  ];
  return (
    <Section title="Salary components" description="Earnings, deductions and employer contributions, applied in order."
      actions={can("hr.salary_structure.create") && <ComponentDialog />}>
      <DataTable columns={columns} rows={components.data?.results} isLoading={components.isLoading} error={components.error} onRetry={components.refetch} caption="Salary components"
        empty={<EmptyState icon={SlidersHorizontal} title="No components yet" description="Start with a fixed basic earning, then add allowances and statutory deductions with their current rates." />} />
    </Section>
  );
}
