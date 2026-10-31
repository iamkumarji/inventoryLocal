"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Gauge, Pencil, Plus, Wrench, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import type { Person } from "@/components/erp/person-picker";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { ActionDialog } from "@/components/production/action-dialog";
import { AssetSelect, useActiveAssets } from "@/components/production/asset-select";
import { PersonField } from "@/components/production/pickers";
import { StateBadge } from "@/components/production/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import {
  dec, isDecimal, localToIso, nowLocal, problemMessage, qty, today, type MaintenancePlan, type MeterReading, type WorkOrder,
} from "@/lib/api/production";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const WO_STATUSES = ["open", "in_progress", "completed", "closed", "cancelled"] as const;

function NewWorkOrder({ open, onOpenChange, presetAsset }: { open: boolean; onOpenChange: (open: boolean) => void; presetAsset: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"breakdown" | "preventive">("breakdown");
  const [asset, setAsset] = useState(presetAsset);
  const [description, setDescription] = useState("");
  const [reportedAt, setReportedAt] = useState(nowLocal());
  const [technician, setTechnician] = useState<Person | null>(null);
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/assets/work-orders/", {
      body: { kind, asset, description, reported_at: localToIso(reportedAt) ?? undefined, technician: technician?.id ?? null },
    })),
    onSuccess: (wo) => {
      queryClient.invalidateQueries({ queryKey: ["assets", "work-orders"] });
      toast(`${wo.number} opened`);
      onOpenChange(false);
      setDescription("");
      router.push(`/assets/work-orders/${wo.id}`);
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  return (
    <ActionDialog open={open} onOpenChange={onOpenChange} title="New work order" description="Report a breakdown or raise ad-hoc preventive work."
      submitLabel="Open work order" pending={create.isPending} error={create.error} disabled={!asset} onSubmit={() => create.mutate()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="wo-kind" label="Kind">
          <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
            <SelectTrigger id="wo-kind" className="h-10 w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="breakdown">Breakdown</SelectItem><SelectItem value="preventive">Preventive</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field id="wo-reported" label="Reported at" error={errors.reported_at}><Input id="wo-reported" type="datetime-local" className="h-10" value={reportedAt} onChange={(e) => setReportedAt(e.target.value)} /></Field>
      </div>
      <Field id="wo-asset" label="Asset" error={errors.asset}><AssetSelect id="wo-asset" value={asset} onChange={setAsset} /></Field>
      <Field id="wo-description" label="What's wrong / what to do" error={errors.description}><Textarea id="wo-description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field id="wo-technician" label="Technician" error={errors.technician}><PersonField id="wo-technician" value={technician} onChange={setTechnician} /></Field>
    </ActionDialog>
  );
}

function WorkOrders() {
  const { can } = useSession();
  const url = useUrlState();
  const status = url.get("status");
  const presetAsset = url.get("asset");
  const [open, setOpen] = useState(url.get("new") === "1");
  const query = useQuery({
    queryKey: ["assets", "work-orders", status, presetAsset, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/assets/work-orders/", {
      params: { query: { status: (status || undefined) as WorkOrder["status"] | undefined, asset: presetAsset || undefined, page: url.page } },
    })),
  });
  const columns: Column<WorkOrder>[] = [
    { key: "number", header: "Work order", cell: (w) => <span><span className="num block">{w.number}<span className="text-muted-foreground sm:hidden"> · {w.asset_code}</span></span><span className="block max-w-[30ch] truncate text-xs font-normal text-muted-foreground">{w.description || (w.kind === "preventive" ? "Preventive maintenance" : "Breakdown")}</span></span> },
    { key: "asset", header: "Asset", className: "hidden sm:table-cell", cell: (w) => <span className="num">{w.asset_code}</span> },
    { key: "status", header: "Status", cell: (w) => <StateBadge kind="workOrder" value={w.status} /> },
    { key: "kind", header: "Kind", className: "hidden sm:table-cell", cell: (w) => (w.kind === "breakdown" ? "Breakdown" : "Preventive") },
    { key: "reported", header: "Reported", className: "hidden md:table-cell", cell: (w) => <span className="text-muted-foreground">{dateTime(w.reported_at ?? w.created_at)}</span> },
  ];
  return (
    <Section actions={
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <Select value={status || "any"} onValueChange={(v) => url.set({ status: v === "any" ? null : v })}>
          <SelectTrigger className="w-36" aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any status</SelectItem>
            {WO_STATUSES.map((s) => <SelectItem key={s} value={s}>{s === "in_progress" ? "In progress" : s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>)}
          </SelectContent>
        </Select>
        {presetAsset && <Button variant="ghost" size="sm" onClick={() => url.set({ asset: null, new: null })}>All assets</Button>}
        {can("assets.work_order.create") && <Button onClick={() => setOpen(true)}><Plus aria-hidden /> New work order</Button>}
      </div>
    }>
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
        rowHref={(w) => `/assets/work-orders/${w.id}`} empty={<EmptyState icon={Wrench} title="No work orders" description="Generate preventive work from plans or report a breakdown." />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      <NewWorkOrder open={open} onOpenChange={(next) => { setOpen(next); if (!next && url.get("new")) url.set({ new: null }); }} presetAsset={presetAsset} />
    </Section>
  );
}

type PlanForm = {
  asset: string; name: string; trigger: "calendar" | "meter"; interval_days: string; interval_meter: string;
  next_due_date: string; next_due_meter: string; checklist: string; is_active: boolean;
};
type PatchedPlan = components["schemas"]["PatchedMaintenancePlanUpdateRequest"];

function PlanDialog({ existing, open, onOpenChange }: { existing: MaintenancePlan | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const blank: PlanForm = { asset: "", name: "", trigger: "calendar", interval_days: "30", interval_meter: "", next_due_date: today(), next_due_meter: "", checklist: "", is_active: true };
  const [form, setForm] = useState<PlanForm>(blank);
  const [technician, setTechnician] = useState<Person | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const marker = open ? (existing?.id ?? null) : undefined;
  if (marker !== loadedFor) {
    setLoadedFor(marker);
    if (open) {
      setTechnician(null);
      setForm(existing ? {
        asset: existing.asset, name: existing.name, trigger: existing.trigger, interval_days: String(existing.interval_days ?? ""),
        interval_meter: existing.interval_meter ? dec.norm(existing.interval_meter) : "", next_due_date: existing.next_due_date ?? "", next_due_meter: existing.next_due_meter ? dec.norm(existing.next_due_meter) : "",
        checklist: (existing.checklist ?? []).map((c) => (typeof c === "string" ? c : String((c as { item?: string }).item ?? ""))).join("\n"),
        is_active: existing.is_active ?? true,
      } : blank);
    }
  }
  const calendar = form.trigger === "calendar";
  const checklist = form.checklist.split("\n").map((s) => s.trim()).filter(Boolean).map((item) => ({ item, done: false }));
  const save = useMutation({
    mutationFn: () => {
      const terms = calendar
        ? { interval_days: Number(form.interval_days), next_due_date: form.next_due_date, interval_meter: null, next_due_meter: null }
        : { interval_meter: form.interval_meter, next_due_meter: form.next_due_meter, interval_days: null, next_due_date: null };
      return existing
        ? unwrap(api.PATCH("/api/v1/assets/maintenance-plans/{id}/", {
          params: { path: { id: existing.id } },
          body: { version: existing.version, name: form.name, checklist, is_active: form.is_active, ...terms, ...(technician ? { technician: technician.id } : {}) } as PatchedPlan,
        }))
        : unwrap(api.POST("/api/v1/assets/maintenance-plans/", {
          body: { asset: form.asset, name: form.name, trigger: form.trigger, checklist, technician: technician?.id ?? null, ...terms },
        }));
    },
    onSuccess: (plan) => {
      queryClient.invalidateQueries({ queryKey: ["assets", "plans"] });
      toast(`Plan "${plan.name}" saved`);
      onOpenChange(false);
    },
    onError: () => queryClient.invalidateQueries({ queryKey: ["assets", "plans"] }),
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  const valid = form.name && (existing || form.asset) && (calendar
    ? /^\d+$/.test(form.interval_days) && Number(form.interval_days) > 0 && form.next_due_date
    : isDecimal(form.interval_meter, { allowZero: false }) && isDecimal(form.next_due_meter));
  return (
    <ActionDialog open={open} onOpenChange={onOpenChange} title={existing ? `Edit plan: ${existing.name}` : "New maintenance plan"}
      description="Preventive work orders are generated when the plan falls due, by date or by meter reading."
      submitLabel={existing ? "Save plan" : "Create plan"} pending={save.isPending} error={save.error} disabled={!valid} onSubmit={() => save.mutate()}>
      {!existing && <Field id="pl-asset" label="Asset" error={errors.asset}><AssetSelect id="pl-asset" value={form.asset} onChange={(asset) => setForm({ ...form, asset })} /></Field>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="pl-name" label="Plan name" error={errors.name}><Input id="pl-name" className="h-10" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field id="pl-trigger" label="Trigger" error={errors.trigger}>
          <Select value={form.trigger} onValueChange={(v) => setForm({ ...form, trigger: v as PlanForm["trigger"] })} disabled={!!existing}>
            <SelectTrigger id="pl-trigger" className="h-10 w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="calendar">Calendar (every N days)</SelectItem><SelectItem value="meter">Meter (every N units)</SelectItem></SelectContent>
          </Select>
        </Field>
        {calendar ? <>
          <Field id="pl-days" label="Every (days)" error={errors.interval_days}><Input id="pl-days" inputMode="numeric" className="num h-10" value={form.interval_days} onChange={(e) => setForm({ ...form, interval_days: e.target.value })} /></Field>
          <Field id="pl-next-date" label="Next due on" error={errors.next_due_date}><Input id="pl-next-date" type="date" className="h-10" value={form.next_due_date} onChange={(e) => setForm({ ...form, next_due_date: e.target.value })} /></Field>
        </> : <>
          <Field id="pl-meter" label="Every (meter units)" error={errors.interval_meter}><Input id="pl-meter" inputMode="decimal" className="num h-10" value={form.interval_meter} onChange={(e) => setForm({ ...form, interval_meter: e.target.value })} /></Field>
          <Field id="pl-next-meter" label="Next due at reading" error={errors.next_due_meter}><Input id="pl-next-meter" inputMode="decimal" className="num h-10" value={form.next_due_meter} onChange={(e) => setForm({ ...form, next_due_meter: e.target.value })} /></Field>
        </>}
      </div>
      <Field id="pl-checklist" label="Checklist" hint="One step per line; copied into each generated work order." error={errors.checklist}>
        <Textarea id="pl-checklist" rows={3} value={form.checklist} onChange={(e) => setForm({ ...form, checklist: e.target.value })} />
      </Field>
      <Field id="pl-tech" label={existing ? "Change technician" : "Technician"} error={errors.technician}><PersonField id="pl-tech" value={technician} onChange={setTechnician} /></Field>
      {existing && (
        <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
          <Label htmlFor="pl-active" className="font-normal">Active</Label>
          <Switch id="pl-active" checked={form.is_active} onCheckedChange={(is_active) => setForm({ ...form, is_active })} />
        </div>
      )}
    </ActionDialog>
  );
}

function Plans() {
  const { can } = useSession();
  const url = useUrlState();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<MaintenancePlan | null>(null);
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(today());
  const query = useQuery({
    queryKey: ["assets", "plans", url.page],
    queryFn: () => unwrap(api.GET("/api/v1/assets/maintenance-plans/", { params: { query: { page: url.page } } })),
  });
  const generate = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/assets/maintenance-plans/generate/", { body: { on } })),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["assets", "plans"] });
      queryClient.invalidateQueries({ queryKey: ["assets", "work-orders"] });
      toast(result.created ? `${result.created} preventive work order${result.created === 1 ? "" : "s"} generated` : "No plan is due; nothing generated");
    },
  });
  const columns: Column<MaintenancePlan>[] = [
    { key: "name", header: "Plan", cell: (p) => <span><span className="block font-medium">{p.name}</span><span className="num block text-xs text-muted-foreground">{p.asset_code}</span></span> },
    { key: "trigger", header: "Every", cell: (p) => <span className="num">{p.trigger === "calendar" ? `${p.interval_days} days` : `${qty(p.interval_meter)} units`}</span> },
    { key: "due", header: "Next due", cell: (p) => <span className="num">{p.trigger === "calendar" ? date(p.next_due_date) : `at ${qty(p.next_due_meter)}`}</span> },
    { key: "last", header: "Last generated", className: "hidden md:table-cell", cell: (p) => <span className="text-muted-foreground">{p.last_generated_at ? dateTime(p.last_generated_at) : "Never"}</span> },
    { key: "active", header: "Status", className: "hidden sm:table-cell", cell: (p) => <ActiveStatus active={p.is_active ?? true} /> },
    ...(can("assets.maintenance_plan.update") ? [{
      key: "edit", header: <span className="sr-only">Edit</span>, align: "right" as const,
      cell: (p: MaintenancePlan) => <Button variant="ghost" size="icon" aria-label={`Edit ${p.name}`} onClick={() => { setEditing(p); setOpen(true); }}><Pencil aria-hidden /></Button>,
    }] : []),
  ];
  return (
    <div className="grid gap-6">
      {can("assets.work_order.create") && (
        <Section title="Generate preventive work orders" description="Creates one work order per due plan occurrence and moves each plan to its next due point. Running it twice is safe.">
          <form className="flex flex-wrap items-end gap-3 px-5 py-4" onSubmit={(e) => { e.preventDefault(); generate.mutate(); }}>
            <Field id="gen-on" label="Due on or before"><Input id="gen-on" type="date" className="h-10" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
            <Button type="submit" size="lg" disabled={generate.isPending || !on}><Zap aria-hidden /> Generate work orders</Button>
            <div className="basis-full"><FormError message={problemMessage(generate.error)} /></div>
          </form>
        </Section>
      )}
      <Section title="Plans" actions={can("assets.maintenance_plan.create") && <Button variant="outline" onClick={() => { setEditing(null); setOpen(true); }}><Plus aria-hidden /> New plan</Button>}>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          empty={<EmptyState icon={CalendarClock} title="No maintenance plans" description="Plans schedule preventive work by calendar or meter." />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
      <PlanDialog existing={editing} open={open} onOpenChange={setOpen} />
    </div>
  );
}

function Meters() {
  const { can } = useSession();
  const url = useUrlState();
  const queryClient = useQueryClient();
  const assets = useActiveAssets();
  const codes = new Map((assets.data?.results ?? []).map((a) => [a.id, a.code]));
  const [asset, setAsset] = useState("");
  const [reading, setReading] = useState("");
  const [at, setAt] = useState(nowLocal());
  const [notes, setNotes] = useState("");
  const query = useQuery({
    queryKey: ["assets", "meter-readings", "all", url.page],
    queryFn: () => unwrap(api.GET("/api/v1/assets/meter-readings/", { params: { query: { page: url.page } } })),
  });
  const add = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/assets/meter-readings/", { body: { asset, reading, reading_at: localToIso(at) ?? undefined, notes } })),
    onSuccess: () => {
      setReading("");
      setNotes("");
      queryClient.invalidateQueries({ queryKey: ["assets", "meter-readings"] });
      toast("Meter reading recorded");
    },
  });
  const columns: Column<MeterReading>[] = [
    { key: "asset", header: "Asset", cell: (m) => <span className="num font-medium">{codes.get(m.asset) ?? "—"}</span> },
    { key: "reading", header: "Reading", align: "right", cell: (m) => <span className="num">{qty(m.reading)}</span> },
    { key: "at", header: "Taken at", cell: (m) => <span className="text-muted-foreground">{dateTime(m.reading_at ?? m.created_at)}</span> },
    { key: "notes", header: "Notes", className: "hidden md:table-cell", cell: (m) => <span className="text-muted-foreground">{m.notes || "—"}</span> },
  ];
  return (
    <div className="grid gap-6">
      {can("assets.meter_reading.create") && (
        <Section title="Record a reading" description="Readings never go down. Meter-based plans fall due when the reading reaches their next due point.">
          <form className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto] lg:items-end" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <Field id="mr-asset" label="Asset"><AssetSelect id="mr-asset" value={asset} onChange={setAsset} /></Field>
            <Field id="mr-reading" label="Reading"><Input id="mr-reading" inputMode="decimal" className="num h-10" value={reading} onChange={(e) => setReading(e.target.value)} /></Field>
            <Field id="mr-at" label="Taken at"><Input id="mr-at" type="datetime-local" className="h-10" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
            <Button type="submit" size="lg" disabled={!asset || !isDecimal(reading) || add.isPending}><Gauge aria-hidden /> Record</Button>
            <Field id="mr-notes" label="Notes" className="sm:col-span-2 lg:col-span-4"><Input id="mr-notes" className="h-10" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <div className="sm:col-span-2 lg:col-span-4"><FormError message={problemMessage(add.error)} /></div>
          </form>
        </Section>
      )}
      <Section title="Readings">
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          empty={<EmptyState icon={Gauge} title="No readings yet" />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </div>
  );
}

export function MaintenanceView() {
  const { can } = useSession();
  const url = useUrlState();
  const tab = url.get("tab") || "work-orders";
  return (
    <>
      <PageHeader title="Maintenance" description="Preventive plans, breakdown work orders and meter readings for the asset register." />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "work-orders" ? null : v, status: null, asset: null, new: null })} className="mb-4">
        <TabsList>
          {can("assets.work_order.read") && <TabsTrigger value="work-orders">Work orders</TabsTrigger>}
          {can("assets.maintenance_plan.read") && <TabsTrigger value="plans">Plans</TabsTrigger>}
          {can("assets.meter_reading.read") && <TabsTrigger value="meters">Meter readings</TabsTrigger>}
        </TabsList>
      </Tabs>
      {tab === "plans" ? <Plans /> : tab === "meters" ? <Meters /> : <WorkOrders />}
    </>
  );
}
