"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Factory, Plus, Warehouse as WarehouseIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { useScopeTree } from "@/lib/api/hooks";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type Kind = "branch" | "facility" | "warehouse" | "department";
type Tree = { companies: Array<{ id: string; code: string; name: string; branches: Array<{ id: string; code: string; name: string;
  facilities: Array<{ id: string; code: string; name: string; type: string }>; warehouses: Array<{ id: string; code: string; name: string; type: string }> }>;
  departments: Array<{ id: string; code: string; name: string; parent_id: string | null }> }> };

type WarehouseType = components["schemas"]["WarehouseCreateRequest"]["warehouse_type"];
type FacilityType = components["schemas"]["FacilityCreateRequest"]["facility_type"];

const WAREHOUSE_TYPES: Record<string, string> = {
  raw_material: "Raw material", wip: "Work in progress", finished_goods: "Finished goods", quarantine: "Quarantine",
  scrap: "Scrap", transit: "In transit", general: "General",
};
const FACILITY_TYPES: Record<string, string> = { plant: "Plant", warehouse_site: "Warehouse site", office: "Office", yard: "Yard" };
const KIND_LABEL: Record<Kind, string> = { branch: "branch", facility: "facility", warehouse: "warehouse", department: "department" };

function CreateNode({ kind, parent, onClose }: { kind: Kind; parent: { companyId: string; branchId?: string }; onClose: () => void }) {
  const queryClient = useQueryClient();
  const tree = useScopeTree();
  const branches = ((tree.data as Tree | undefined)?.companies.find((c) => c.id === parent.companyId)?.branches) ?? [];
  const [form, setForm] = useState({ code: "", name: "", type: kind === "warehouse" ? "raw_material" : "plant", branch: parent.branchId ?? "", facility: "" });
  const facilities = branches.find((b) => b.id === form.branch)?.facilities ?? [];
  const create = useMutation({
    mutationFn: async (): Promise<unknown> => {
      if (kind === "branch") {
        return unwrap(api.POST("/api/v1/organization/branches/", { body: { company: parent.companyId, code: form.code, name: form.name } }));
      }
      if (kind === "department") {
        return unwrap(api.POST("/api/v1/organization/departments/", { body: { company: parent.companyId, code: form.code, name: form.name } }));
      }
      if (kind === "facility") {
        return unwrap(api.POST("/api/v1/organization/facilities/", {
          body: { branch: form.branch, code: form.code, name: form.name, facility_type: form.type as FacilityType },
        }));
      }
      return unwrap(api.POST("/api/v1/organization/warehouses/", {
        body: { branch: form.branch, facility: form.facility || null, code: form.code, name: form.name, warehouse_type: form.type as WarehouseType },
      }));
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["organization"] }); toast(`${form.name} added`); onClose(); },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  const needsBranch = kind === "facility" || kind === "warehouse";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <DialogHeader><DialogTitle>Add a {KIND_LABEL[kind]}</DialogTitle>
            <DialogDescription>Codes are permanent identifiers used on documents and reports.</DialogDescription></DialogHeader>
          <FormError message={create.error && !isApiError(create.error, "validation_error") ? (isApiError(create.error) ? create.error.summary() : "Couldn't reach the server.") : undefined} />
          {needsBranch && (
            <Field id="branch" label="Branch" error={errors.branch}>
              <Select value={form.branch} onValueChange={(v) => setForm({ ...form, branch: v, facility: "" })}>
                <SelectTrigger id="branch" className="w-full"><SelectValue placeholder="Choose a branch" /></SelectTrigger>
                <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3">
            <Field id="code" label="Code" error={errors.code}><Input id="code" className="num uppercase" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} required /></Field>
            <Field id="name" label="Name" error={errors.name}><Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
          </div>
          {needsBranch && (
            <Field id="type" label="Type">
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                <SelectTrigger id="type" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(kind === "warehouse" ? WAREHOUSE_TYPES : FACILITY_TYPES).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          {kind === "warehouse" && facilities.length > 0 && (
            <Field id="facility" label="Facility (optional)">
              <Select value={form.facility || "__none__"} onValueChange={(v) => setForm({ ...form, facility: v === "__none__" ? "" : v })}>
                <SelectTrigger id="facility" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="__none__">Not inside a facility</SelectItem>{facilities.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          <DialogFooter><Button type="submit" disabled={create.isPending || !form.code || !form.name || (needsBranch && !form.branch)}>Add {KIND_LABEL[kind]}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Structure() {
  const { can } = useSession();
  const tree = useScopeTree();
  const [creating, setCreating] = useState<{ kind: Kind; companyId: string; branchId?: string } | null>(null);
  if (tree.isLoading) return <RowsSkeleton />;
  if (tree.error) return <ErrorState error={tree.error} onRetry={tree.refetch} />;
  const companies = (tree.data as Tree).companies;
  if (companies.length === 0) return <Section><EmptyState icon={Building2} title="No companies visible to you" /></Section>;
  const add = (kind: Kind, companyId: string, branchId?: string) => can(`organization.${kind}.create`) && (
    <Button size="sm" variant="ghost" onClick={() => setCreating({ kind, companyId, branchId })}><Plus aria-hidden /> {KIND_LABEL[kind]}</Button>
  );
  return (
    <div className="grid gap-6">
      {companies.map((company) => (
        <Section key={company.id} title={company.name} description={`Company ${company.code}`}
          actions={<div className="flex gap-1">{add("branch", company.id)}{add("department", company.id)}</div>}>
          <div className="grid gap-0 divide-y">
            {company.branches.length === 0 && <EmptyState title="No branches yet" description="Branches hold plants, offices and warehouses." />}
            {company.branches.map((branch) => (
              <div key={branch.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{branch.name} <span className="num text-sm text-muted-foreground">{branch.code}</span></p>
                  <div className="flex gap-1">{add("facility", company.id, branch.id)}{add("warehouse", company.id, branch.id)}</div>
                </div>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="mb-1.5 text-xs text-muted-foreground">Facilities</p>
                    {branch.facilities.length === 0 ? <p className="text-sm text-muted-foreground">None</p> : (
                      <ul className="grid gap-1 text-sm">{branch.facilities.map((f) => (
                        <li key={f.id} className="flex items-center gap-2"><Factory className="size-3.5 text-muted-foreground" aria-hidden />{f.name}<span className="num text-xs text-muted-foreground">{f.code}</span><span className="text-xs text-muted-foreground">{FACILITY_TYPES[f.type]}</span></li>
                      ))}</ul>
                    )}
                  </div>
                  <div>
                    <p className="mb-1.5 text-xs text-muted-foreground">Warehouses</p>
                    {branch.warehouses.length === 0 ? <p className="text-sm text-muted-foreground">None</p> : (
                      <ul className="grid gap-1 text-sm">{branch.warehouses.map((w) => (
                        <li key={w.id} className="flex items-center gap-2"><WarehouseIcon className="size-3.5 text-muted-foreground" aria-hidden />{w.name}<span className="num text-xs text-muted-foreground">{w.code}</span><StatusBadge tone="neutral">{WAREHOUSE_TYPES[w.type] ?? w.type}</StatusBadge></li>
                      ))}</ul>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {company.departments.length > 0 && (
              <div className="px-5 py-4">
                <p className="mb-1.5 text-xs text-muted-foreground">Departments</p>
                <ul className="flex flex-wrap gap-2 text-sm">{company.departments.map((d) => <li key={d.id} className="rounded-sm border px-2 py-0.5">{d.name}</li>)}</ul>
              </div>
            )}
          </div>
        </Section>
      ))}
      {creating && <CreateNode kind={creating.kind} parent={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}

type FiscalYear = components["schemas"]["FiscalYear"];

function FiscalYears() {
  const { me, can } = useSession();
  const queryClient = useQueryClient();
  const years = useQuery({ queryKey: ["organization", "fiscal-years"], queryFn: () => unwrap(api.GET("/api/v1/organization/fiscal-years/")) });
  const nextStart = (() => {
    const latest = years.data?.results[0];
    return latest ? Number(latest.end_date.slice(0, 4)) : new Date().getFullYear();
  })();
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/organization/fiscal-years/", { body: { company: me.active_company_id!, start_year: nextStart } })),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["organization", "fiscal-years"] }); toast("Fiscal year created with 12 monthly periods"); },
    onError: (e) => toast.error(isApiError(e) ? e.summary() : "Couldn't reach the server."),
  });
  const columns: Column<FiscalYear>[] = [
    { key: "code", header: "Year", cell: (y) => <span className="num">{y.code}</span> },
    { key: "range", header: "Runs", cell: (y) => `${date(y.start_date)} to ${date(y.end_date)}` },
    { key: "periods", header: "Periods", align: "right", cell: (y) => <span className="num">{y.periods.length}</span> },
    { key: "open", header: "Open periods", align: "right", cell: (y) => <span className="num">{y.periods.filter((p) => p.status === "open").length}</span> },
    { key: "status", header: "Status", cell: (y) => <StatusBadge tone={y.status === "open" ? "approved" : y.status === "closing" ? "pending" : "neutral"}>{y.status.charAt(0).toUpperCase() + y.status.slice(1)}</StatusBadge> },
  ];
  return (
    <Section title="Fiscal years" description="Postings are allowed only into open periods."
      actions={can("organization.fiscal_year.create") && me.active_company_id && <Button size="sm" variant="outline" onClick={() => create.mutate()} disabled={create.isPending}><Plus aria-hidden /> Add FY starting {nextStart}</Button>}>
      <DataTable columns={columns} rows={years.data?.results} isLoading={years.isLoading} error={years.error} onRetry={years.refetch}
        empty={<EmptyState title="No fiscal years" description="Create one before any document can be numbered or posted." />} />
    </Section>
  );
}

export function OrganizationView() {
  const url = useUrlState();
  const { can } = useSession();
  const tab = url.get("tab") || "structure";
  return (
    <>
      <PageHeader title="Organization" description="Companies, branches, plants, warehouses and departments. Access grants and documents refer to these." />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "structure" ? null : v })}>
        <TabsList className="mb-4">
          <TabsTrigger value="structure">Structure</TabsTrigger>
          {can("organization.fiscal_year.read") && <TabsTrigger value="fiscal">Fiscal years</TabsTrigger>}
        </TabsList>
        <TabsContent value="structure"><Structure /></TabsContent>
        <TabsContent value="fiscal"><FiscalYears /></TabsContent>
      </Tabs>
    </>
  );
}
