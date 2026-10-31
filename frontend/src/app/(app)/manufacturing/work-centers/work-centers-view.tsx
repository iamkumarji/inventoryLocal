"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cog, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { ActionDialog } from "@/components/production/action-dialog";
import { PlaceSelect } from "@/components/production/pickers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { isDecimal, useOrgPlaces, type WorkCenter } from "@/lib/api/production";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

// `version` is read from the body for optimistic locking but isn't in the generated request type.
type PatchedWorkCenter = components["schemas"]["PatchedWorkCenterRequest"];

type Form = {
  code: string; name: string; facility: string; capacity_hours_per_day: string;
  labour_rate: string; machine_rate: string; overhead_rate: string; is_active: boolean;
};

const BLANK: Form = { code: "", name: "", facility: "", capacity_hours_per_day: "8", labour_rate: "0", machine_rate: "0", overhead_rate: "0", is_active: true };

function WorkCenterDialog({ existing, open, onOpenChange }: { existing: WorkCenter | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { companyId } = useOrgPlaces();
  const [form, setForm] = useState<Form>(BLANK);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const marker = open ? (existing?.id ?? null) : undefined;
  if (marker !== loadedFor) {
    setLoadedFor(marker);
    if (open) {
      setForm(existing ? {
        code: existing.code, name: existing.name, facility: existing.facility,
        capacity_hours_per_day: existing.capacity_hours_per_day ?? "8", labour_rate: existing.labour_rate ?? "0",
        machine_rate: existing.machine_rate ?? "0", overhead_rate: existing.overhead_rate ?? "0", is_active: existing.is_active ?? true,
      } : BLANK);
    }
  }
  const save = useMutation({
    mutationFn: () => {
      const rates = { name: form.name, capacity_hours_per_day: form.capacity_hours_per_day, labour_rate: form.labour_rate, machine_rate: form.machine_rate, overhead_rate: form.overhead_rate, is_active: form.is_active };
      return existing
        ? unwrap(api.PATCH("/api/v1/manufacturing/work-centers/{id}/", { params: { path: { id: existing.id } }, body: { ...rates, version: existing.version } as PatchedWorkCenter }))
        : unwrap(api.POST("/api/v1/manufacturing/work-centers/", { body: { ...rates, code: form.code, facility: form.facility, company: companyId } }));
    },
    onSuccess: (wc) => {
      queryClient.invalidateQueries({ queryKey: ["manufacturing", "work-centers"] });
      toast(existing ? `${wc.code} saved` : `${wc.code} created`);
      onOpenChange(false);
    },
    onError: () => queryClient.invalidateQueries({ queryKey: ["manufacturing", "work-centers"] }),
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  const rateFields = ["capacity_hours_per_day", "labour_rate", "machine_rate", "overhead_rate"] as const;
  const invalid = rateFields.some((k) => !isDecimal(form[k], { maxDp: 4 })) || !form.name || (!existing && (!form.code || !form.facility));
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <ActionDialog open={open} onOpenChange={onOpenChange} title={existing ? `Edit ${existing.code}` : "New work centre"}
      description="Hourly rates turn the minutes booked on operations into labour, machine and overhead cost."
      submitLabel={existing ? "Save" : "Create work centre"} pending={save.isPending} error={save.error} disabled={invalid} onSubmit={() => save.mutate()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="wc-code" label="Code" error={errors.code} hint={existing ? "Codes can't change; routings refer to them." : "Routings refer to this code."}>
          <Input id="wc-code" value={form.code} onChange={set("code")} disabled={!!existing} required className="num" />
        </Field>
        <Field id="wc-name" label="Name" error={errors.name}><Input id="wc-name" value={form.name} onChange={set("name")} required /></Field>
      </div>
      {!existing && (
        <Field id="wc-facility" label="Facility" error={errors.facility}>
          <PlaceSelect id="wc-facility" kind="facility" value={form.facility} onChange={(facility) => setForm({ ...form, facility })} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Field id="wc-capacity" label="Capacity (hours/day)" error={errors.capacity_hours_per_day}><Input id="wc-capacity" inputMode="decimal" value={form.capacity_hours_per_day} onChange={set("capacity_hours_per_day")} className="num" /></Field>
        <Field id="wc-labour" label="Labour rate (₹/h)" error={errors.labour_rate}><Input id="wc-labour" inputMode="decimal" value={form.labour_rate} onChange={set("labour_rate")} className="num" /></Field>
        <Field id="wc-machine" label="Machine rate (₹/h)" error={errors.machine_rate}><Input id="wc-machine" inputMode="decimal" value={form.machine_rate} onChange={set("machine_rate")} className="num" /></Field>
        <Field id="wc-overhead" label="Overhead rate (₹/h)" error={errors.overhead_rate}><Input id="wc-overhead" inputMode="decimal" value={form.overhead_rate} onChange={set("overhead_rate")} className="num" /></Field>
      </div>
      <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
        <Label htmlFor="wc-active" className="font-normal">Active (available to routings at release)</Label>
        <Switch id="wc-active" checked={form.is_active} onCheckedChange={(is_active) => setForm({ ...form, is_active })} />
      </div>
    </ActionDialog>
  );
}

export function WorkCentersView() {
  const { can } = useSession();
  const url = useUrlState();
  const places = useOrgPlaces();
  const [editing, setEditing] = useState<WorkCenter | null>(null);
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["manufacturing", "work-centers", url.page],
    queryFn: () => unwrap(api.GET("/api/v1/manufacturing/work-centers/", { params: { query: { page: url.page } } })),
  });
  const columns: Column<WorkCenter>[] = [
    { key: "code", header: "Work centre", cell: (w) => <span><span className="num block font-medium">{w.code}</span><span className="block text-xs text-muted-foreground">{w.name}</span></span> },
    { key: "facility", header: "Facility", className: "hidden md:table-cell", cell: (w) => places.label(w.facility) },
    { key: "capacity", header: "Hours/day", align: "right", className: "hidden sm:table-cell", cell: (w) => <span className="num">{w.capacity_hours_per_day}</span> },
    { key: "labour", header: "Labour/h", align: "right", cell: (w) => <span className="num">{money(w.labour_rate)}</span> },
    { key: "machine", header: "Machine/h", align: "right", className: "hidden sm:table-cell", cell: (w) => <span className="num">{money(w.machine_rate)}</span> },
    { key: "overhead", header: "Overhead/h", align: "right", className: "hidden lg:table-cell", cell: (w) => <span className="num">{money(w.overhead_rate)}</span> },
    { key: "state", header: "Status", className: "hidden sm:table-cell", cell: (w) => <ActiveStatus active={w.is_active ?? true} /> },
    ...(can("manufacturing.work_center.update") ? [{
      key: "edit", header: <span className="sr-only">Edit</span>, align: "right" as const,
      cell: (w: WorkCenter) => <Button variant="ghost" size="icon" aria-label={`Edit ${w.code}`} onClick={() => { setEditing(w); setOpen(true); }}><Pencil aria-hidden /></Button>,
    }] : []),
  ];
  return (
    <>
      <PageHeader title="Work centres" description="Machines and lines that run routing operations, with the hourly rates used for conversion cost."
        actions={can("manufacturing.work_center.create") && <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus aria-hidden /> New work centre</Button>} />
      <Section>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          empty={<EmptyState icon={Cog} title="No work centres yet" description="Create one for each machine or line your routings use." />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
      <WorkCenterDialog existing={editing} open={open} onOpenChange={setOpen} />
    </>
  );
}
