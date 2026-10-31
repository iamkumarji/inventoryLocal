"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Layers, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { errorText, humanize, isMoney, trimDecimal, useSalaryComponents, useSalaryStructures, type SalaryStructure } from "@/lib/api/people";
import { useSession } from "@/lib/session";

type Pick = { on: boolean; amount: string; rate: string };

function NewStructure() {
  const { activeCompany } = useSession();
  const queryClient = useQueryClient();
  const components = useSalaryComponents();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const active = (components.data?.results ?? []).filter((c) => c.is_active ?? true);
  const chosen = active.filter((c) => picks[c.id]?.on);
  const invalid = chosen.some((c) => {
    const p = picks[c.id];
    return (p.amount.trim() && !isMoney(p.amount)) || (p.rate.trim() && !/^\d+(\.\d{1,4})?$/.test(p.rate.trim()));
  });
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/hr/salary-structures/", {
      body: {
        company: activeCompany?.id ?? "",
        code: code.trim(),
        name: name.trim(),
        lines: chosen.map((c) => ({
          component: c.id,
          amount: c.calculation === "fixed" || !c.calculation ? picks[c.id].amount.trim() || null : null,
          rate_pct: c.calculation && c.calculation !== "fixed" ? picks[c.id].rate.trim() || null : null,
        })),
      },
    })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", "salary-structures"] });
      setOpen(false);
      setCode(""); setName(""); setPicks({});
      toast("Salary structure added");
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  const update = (id: string, patch: Partial<Pick>) => setPicks({ ...picks, [id]: { ...(picks[id] ?? { on: false, amount: "", rate: "" }), ...patch } });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus aria-hidden /> Structure</Button></DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Add a salary structure</DialogTitle>
            <DialogDescription>Pick exactly one basic component. Fixed amounts here are defaults; each employee&apos;s salary can override them.</DialogDescription>
          </DialogHeader>
          <FormError message={create.error && !isApiError(create.error, "validation_error") ? errorText(create.error) : (errors.lines ?? errors._form)} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="ss-code" label="Code" error={errors.code}><Input id="ss-code" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={20} /></Field>
            <Field id="ss-name" label="Name" error={errors.name} className="sm:col-span-2"><Input id="ss-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} /></Field>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Components</legend>
            {active.length === 0 && <p className="text-sm text-muted-foreground">Add salary components first.</p>}
            {active.map((c) => {
              const p = picks[c.id] ?? { on: false, amount: "", rate: "" };
              const fixed = c.calculation === "fixed" || !c.calculation;
              return (
                <div key={c.id} className="grid gap-2 rounded-md border px-3 py-2 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-center">
                  <label className="flex items-start gap-2.5 text-sm">
                    <Checkbox checked={p.on} onCheckedChange={(v) => update(c.id, { on: v === true })} aria-label={`Include ${c.code}`} className="mt-0.5" />
                    <span>
                      <span className="block font-medium">{c.name} <span className="font-normal text-muted-foreground">({c.code})</span></span>
                      <span className="block text-xs text-muted-foreground">{humanize(c.kind)} · {fixed ? "fixed" : `${trimDecimal(c.rate_pct)}% of ${c.calculation === "percent_of_basic" ? "basic" : "gross"}`}{c.is_basic ? " · basic" : ""}</span>
                    </span>
                  </label>
                  {p.on && (fixed
                    ? <Input inputMode="decimal" placeholder="Monthly amount" aria-label={`${c.code} monthly amount`} value={p.amount} onChange={(e) => update(c.id, { amount: e.target.value })} />
                    : <Input inputMode="decimal" placeholder={`Rate % (default ${trimDecimal(c.rate_pct)})`} aria-label={`${c.code} rate override`} value={p.rate} onChange={(e) => update(c.id, { rate: e.target.value })} />)}
                </div>
              );
            })}
          </fieldset>
          <DialogFooter><Button type="submit" disabled={create.isPending || chosen.length === 0 || invalid}>Add structure</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function StructuresTab() {
  const { can } = useSession();
  const structures = useSalaryStructures();
  const columns: Column<SalaryStructure>[] = [
    { key: "name", header: "Structure", cell: (s) => <span><span className="block">{s.name}</span><span className="block text-xs text-muted-foreground">{s.code}</span></span> },
    { key: "lines", header: "Components", cell: (s) => <span className="text-muted-foreground">{s.lines.map((l) => l.component_code).join(", ") || "—"}</span> },
    { key: "active", header: "Status", cell: (s) => <ActiveStatus active={s.is_active} />, className: "hidden sm:table-cell" },
  ];
  return (
    <Section title="Salary structures" description="Bundles of components assigned to employees."
      actions={can("hr.salary_structure.create") && <NewStructure />}>
      <DataTable columns={columns} rows={structures.data?.results} isLoading={structures.isLoading} error={structures.error} onRetry={structures.refetch} caption="Salary structures"
        empty={<EmptyState icon={Layers} title="No structures yet" />} />
    </Section>
  );
}
