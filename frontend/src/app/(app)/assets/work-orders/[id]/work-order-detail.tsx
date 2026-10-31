"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Lock, PackageMinus, Play, Plus, Trash2, XCircle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { RecordPanel } from "@/components/collaboration/record-panel";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import type { Person } from "@/components/erp/person-picker";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionDialog, Facts } from "@/components/production/action-dialog";
import { readChecklist, type ChecklistEntry } from "@/components/production/asset-select";
import { ItemPicker, PersonField, PlaceSelect, type ItemRef } from "@/components/production/pickers";
import { StateBadge } from "@/components/production/status";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import {
  isDecimal, localToIso, nowLocal, problemMessage, qty, today, useOrgPlaces, usePersonLabel, type WorkOrder,
} from "@/lib/api/production";
import { date, dateTime, money } from "@/lib/format";
import { useSession } from "@/lib/session";

type Done = (wo: WorkOrder, message: string) => void;

function StartDialog({ wo, onDone, onFail }: { wo: WorkOrder; onDone: Done; onFail: () => void }) {
  const [open, setOpen] = useState(false);
  const [startedAt, setStartedAt] = useState(nowLocal());
  const [technician, setTechnician] = useState<Person | null>(null);
  const start = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/assets/work-orders/{id}/start/", {
      params: { path: { id: wo.id } },
      body: { started_at: localToIso(startedAt), version: wo.version, ...(technician ? { technician: technician.id } : {}) },
    })),
    onSuccess: (w) => { onDone(w, "Work started"); setOpen(false); },
    onError: onFail,
  });
  return (
    <ActionDialog open={open} onOpenChange={setOpen} trigger={<Button size="lg" className="h-12 justify-start text-base"><Play aria-hidden /> Start work</Button>}
      title={`Start ${wo.number}`} submitLabel="Start work" pending={start.isPending} error={start.error} onSubmit={() => start.mutate()}>
      <Field id="start-at" label="Started at"><Input id="start-at" type="datetime-local" className="h-12" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} /></Field>
      <Field id="start-tech" label="Technician" hint={wo.technician ? "Leave empty to keep the assigned technician." : undefined}><PersonField id="start-tech" value={technician} onChange={setTechnician} /></Field>
    </ActionDialog>
  );
}

type SpareRow = { key: number; item: ItemRef | null; warehouse: string; quantity: string };
let spareKey = 0;

function SparesDialog({ wo, onDone, onFail }: { wo: WorkOrder; onDone: Done; onFail: () => void }) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(today());
  const [rows, setRows] = useState<SpareRow[]>([{ key: ++spareKey, item: null, warehouse: "", quantity: "1" }]);
  const issue = useMutation({
    mutationFn: () => {
      const key = idempotencyKey();
      return unwrap(api.POST("/api/v1/assets/work-orders/{id}/issue-spares/", {
        params: { path: { id: wo.id }, header: { "Idempotency-Key": key } },
        body: { on, version: wo.version, lines: rows.map((r) => ({ item: r.item!.id, warehouse: r.warehouse, quantity: r.quantity, batch_number: "" })) },
      }));
    },
    onSuccess: (w) => { onDone(w, "Spares issued"); setOpen(false); setRows([{ key: ++spareKey, item: null, warehouse: "", quantity: "1" }]); },
    onError: onFail,
  });
  const set = (key: number, patch: Partial<SpareRow>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const valid = rows.length > 0 && rows.every((r) => r.item && r.warehouse && isDecimal(r.quantity, { allowZero: false }));
  return (
    <ActionDialog wide open={open} onOpenChange={setOpen} trigger={<Button size="lg" variant="outline" className="h-12 justify-start text-base"><PackageMinus aria-hidden /> Issue spares</Button>}
      title="Issue spares" description="Takes spares out of stock at their current value and adds the cost to this work order."
      submitLabel="Issue spares" pending={issue.isPending} error={issue.error} disabled={!valid} onSubmit={() => issue.mutate()}>
      <Field id="sp-on" label="Posting date"><Input id="sp-on" type="date" className="h-10" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      {rows.map((r, index) => (
        <div key={r.key} className="grid min-w-0 gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_6rem_auto] sm:items-end">
          <Field id={`sp-item-${r.key}`} label={`Spare ${index + 1}`}><ItemPicker id={`sp-item-${r.key}`} value={r.item} onChange={(item) => set(r.key, { item })} /></Field>
          <Field id={`sp-wh-${r.key}`} label="From warehouse"><PlaceSelect id={`sp-wh-${r.key}`} kind="warehouse" value={r.warehouse} onChange={(warehouse) => set(r.key, { warehouse })} /></Field>
          <Field id={`sp-qty-${r.key}`} label="Quantity"><Input id={`sp-qty-${r.key}`} inputMode="decimal" className="num h-10" value={r.quantity} onChange={(e) => set(r.key, { quantity: e.target.value })} /></Field>
          <Button type="button" variant="ghost" size="icon-lg" aria-label={`Remove spare ${index + 1}`} disabled={rows.length === 1} onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}><Trash2 aria-hidden /></Button>
        </div>
      ))}
      <Button type="button" variant="outline" className="justify-self-start" onClick={() => setRows((all) => [...all, { key: ++spareKey, item: null, warehouse: all.at(-1)?.warehouse ?? "", quantity: "1" }])}><Plus aria-hidden /> Add spare</Button>
    </ActionDialog>
  );
}

function CompleteDialog({ wo, onDone, onFail }: { wo: WorkOrder; onDone: Done; onFail: () => void }) {
  const [open, setOpen] = useState(false);
  const [completedAt, setCompletedAt] = useState(nowLocal());
  const [downtime, setDowntime] = useState("");
  const [hours, setHours] = useState("");
  const [notes, setNotes] = useState("");
  const [checklist, setChecklist] = useState<ChecklistEntry[]>([]);
  const complete = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/assets/work-orders/{id}/complete/", {
      params: { path: { id: wo.id } },
      body: {
        completed_at: localToIso(completedAt), notes, version: wo.version,
        downtime_minutes: downtime === "" ? null : Number(downtime),
        labour_hours: hours === "" ? null : hours,
        ...(checklist.length ? { checklist } : {}),
      },
    })),
    onSuccess: (w) => { onDone(w, "Work order completed"); setOpen(false); },
    onError: onFail,
  });
  const valid = (downtime === "" || /^\d+$/.test(downtime)) && (hours === "" || isDecimal(hours, { maxDp: 2 }));
  return (
    <ActionDialog open={open} onOpenChange={(next) => { if (next) { setChecklist(readChecklist(wo.checklist)); setCompletedAt(nowLocal()); } setOpen(next); }}
      trigger={<Button size="lg" className="h-12 justify-start text-base"><CheckCheck aria-hidden /> Complete</Button>}
      title={`Complete ${wo.number}`} description="Downtime defaults to reported → completed for breakdowns, and started → completed for preventive work."
      submitLabel="Complete work" pending={complete.isPending} error={complete.error} disabled={!valid} onSubmit={() => complete.mutate()}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="c-at" label="Completed at" className="sm:col-span-3"><Input id="c-at" type="datetime-local" className="h-12" value={completedAt} onChange={(e) => setCompletedAt(e.target.value)} /></Field>
        <Field id="c-downtime" label="Downtime (min)" hint="Empty: calculated"><Input id="c-downtime" inputMode="numeric" className="num h-12 text-base" value={downtime} onChange={(e) => setDowntime(e.target.value)} /></Field>
        <Field id="c-hours" label="Labour hours"><Input id="c-hours" inputMode="decimal" className="num h-12 text-base" value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
      </div>
      {checklist.length > 0 && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Checklist</legend>
          {checklist.map((c, i) => (
            <label key={i} className="flex min-h-11 items-center gap-3 rounded-md border px-3">
              <Checkbox checked={c.done} onCheckedChange={(v) => setChecklist(checklist.map((x, j) => (j === i ? { ...x, done: v === true } : x)))} />
              <span className="text-sm">{c.item}</span>
            </label>
          ))}
        </fieldset>
      )}
      <Field id="c-notes" label="Notes"><Textarea id="c-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </ActionDialog>
  );
}

function CancelDialog({ wo, onDone, onFail }: { wo: WorkOrder; onDone: Done; onFail: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const cancel = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/assets/work-orders/{id}/cancel/", { params: { path: { id: wo.id } }, body: { reason, version: wo.version } })),
    onSuccess: (w) => { onDone(w, "Work order cancelled"); setOpen(false); },
    onError: onFail,
  });
  return (
    <ActionDialog open={open} onOpenChange={setOpen} trigger={<Button size="lg" variant="outline" className="h-12 justify-start text-base"><XCircle aria-hidden /> Cancel work order</Button>}
      title={`Cancel ${wo.number}`} description="Work orders with spares issued can't be cancelled; complete and close them instead."
      submitLabel="Cancel work order" destructive pending={cancel.isPending} error={cancel.error} disabled={!reason.trim()} onSubmit={() => cancel.mutate()}>
      <Field id="cancel-reason" label="Reason"><Input id="cancel-reason" className="h-10" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </ActionDialog>
  );
}

export function WorkOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const places = useOrgPlaces();
  const person = usePersonLabel();
  const queryClient = useQueryClient();
  const key = ["assets", "work-order", id];
  const query = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/api/v1/assets/work-orders/{id}/", { params: { path: { id } } })) });
  const onDone: Done = (wo, message) => {
    queryClient.setQueryData(key, wo);
    queryClient.invalidateQueries({ queryKey: ["assets", "work-orders"] });
    queryClient.invalidateQueries({ queryKey: ["collaboration", "activity"] });
    toast(message);
  };
  const onFail = () => queryClient.invalidateQueries({ queryKey: key });
  const close = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/assets/work-orders/{id}/close/", { params: { path: { id } }, body: { version: query.data!.version } })),
    onSuccess: (w) => onDone(w, "Work order closed"),
    onError: onFail,
  });

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const wo = query.data!;
  const working = wo.status === "open" || wo.status === "in_progress";
  const checklist = readChecklist(wo.checklist);
  const props = { wo, onDone, onFail };

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Maintenance", href: "/assets/maintenance" }, { label: wo.number }]}
        title={<span className="num">{wo.number}</span>}
        meta={<>
          <StateBadge kind="workOrder" value={wo.status} />
          <span>{wo.kind === "breakdown" ? "Breakdown" : "Preventive"} on <Link href={`/assets/${wo.asset}`} className="num font-medium underline-offset-4 hover:underline">{wo.asset_code}</Link></span>
          <span className="text-muted-foreground">Reported {dateTime(wo.reported_at ?? wo.created_at)}</span>
        </>}
      />
      <Section title="Work" className="mb-6">
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
          {wo.status === "open" && can("assets.work_order.update") && <StartDialog {...props} />}
          {working && can("assets.work_order.update") && <SparesDialog {...props} />}
          {working && can("assets.work_order.update") && <CompleteDialog {...props} />}
          {wo.status === "completed" && can("assets.work_order.close") && (
            <Button size="lg" className="h-12 justify-start text-base" onClick={() => close.mutate()} disabled={close.isPending}><Lock aria-hidden /> Close work order</Button>
          )}
          {working && can("assets.work_order.close") && <CancelDialog {...props} />}
          {(wo.status === "closed" || wo.status === "cancelled") && <p className="text-sm text-muted-foreground">This work order is {wo.status}.</p>}
        </div>
        {close.error && <div className="px-5 pb-4"><FormError message={problemMessage(close.error)} /></div>}
      </Section>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 content-start gap-6">
          {wo.description && <Section title="Description"><p className="px-5 py-4 text-sm whitespace-pre-wrap">{wo.description}</p></Section>}
          {checklist.length > 0 && (
            <Section title="Checklist">
              <ul className="divide-y">
                {checklist.map((c, i) => (
                  <li key={i} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <Checkbox checked={c.done} disabled aria-label={c.item} /><Label className="font-normal">{c.item}</Label>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="Spares issued" description={`Spare cost ${money(wo.spare_cost)}`}>
            {wo.spares.length === 0 ? <p className="px-5 py-4 text-sm text-muted-foreground">No spares issued.</p> : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow className="hover:bg-transparent">
                    <TableHead>Item</TableHead><TableHead>Warehouse</TableHead><TableHead className="text-right">Quantity</TableHead><TableHead className="text-right">Value</TableHead><TableHead>Issued</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {wo.spares.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="num font-medium">{s.item_code}</TableCell><TableCell>{places.code(s.warehouse)}</TableCell>
                        <TableCell className="num text-right">{qty(s.quantity)}</TableCell><TableCell className="num text-right">{money(s.value)}</TableCell>
                        <TableCell className="text-muted-foreground">{date(s.issued_on)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <Section title="Details">
            <Facts items={[
              ["Technician", wo.technician ? person(wo.technician, "Assigned") : "Unassigned"],
              ["Facility", places.label(wo.facility)],
              ["Started", dateTime(wo.started_at)],
              ["Completed", dateTime(wo.completed_at)],
              ["Closed", dateTime(wo.closed_at)],
              ["Downtime", `${wo.downtime_minutes} min`],
              ["Labour", `${qty(wo.labour_hours)} h`],
              wo.notes && ["Notes", wo.notes],
              wo.plan && ["From plan", wo.due_key || "Preventive plan"],
            ]} />
          </Section>
          <RecordPanel resourceType="assets.work_order" resourceId={wo.id} />
        </div>
      </div>
    </>
  );
}
