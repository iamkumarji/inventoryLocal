"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Lock, PackageCheck, PackageMinus, Play, Timer, Trash } from "lucide-react";
import { useParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { RecordPanel } from "@/components/collaboration/record-panel";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionDialog, Facts, Figure } from "@/components/production/action-dialog";
import { StateBadge } from "@/components/production/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, unwrap } from "@/lib/api/client";
import {
  dec, isDecimal, problemMessage, qty, today, useOrgPlaces,
  type Availability, type Costing, type ProductionMaterial, type ProductionOperation, type ProductionOrder,
} from "@/lib/api/production";
import { date, money } from "@/lib/format";
import { useSession } from "@/lib/session";

const inWip = (m: ProductionMaterial) => dec.sub(dec.sub(m.issued_quantity, m.consumed_quantity), m.returned_quantity);

/** Large shop-floor action button. */
function FloorButton({ children, ...props }: React.ComponentProps<typeof Button>) {
  return <Button size="lg" className="h-12 min-w-0 justify-start px-4 text-base" {...props}>{children}</Button>;
}

type ActionProps = { order: ProductionOrder; onDone: (order: ProductionOrder, message: string) => void; onFail: () => void; trigger: ReactNode };

function useOrderAction<T>(fn: (input: T) => Promise<ProductionOrder>, { onDone, onFail }: Pick<ActionProps, "onDone" | "onFail">, message: string, close: () => void) {
  return useMutation({
    mutationFn: fn,
    onSuccess: (order) => { onDone(order, message); close(); },
    onError: onFail,
  });
}

function IssueDialog({ order, ...props }: ActionProps) {
  const [open, setOpen] = useState(false);
  const manual = order.materials.filter((m) => m.issue_method === "manual");
  const [on, setOn] = useState(today());
  const [lines, setLines] = useState<Record<string, string>>({});
  const openWithDefaults = (next: boolean) => {
    if (next) setLines(Object.fromEntries(manual.map((m) => [m.id, dec.max0(dec.sub(m.required_quantity, m.issued_quantity))])));
    setOpen(next);
  };
  const chosen = manual.filter((m) => dec.positive(lines[m.id]));
  const valid = chosen.length > 0 && manual.every((m) => !lines[m.id] || isDecimal(lines[m.id]!));
  const issue = useOrderAction(() => unwrap(api.POST("/api/v1/manufacturing/orders/{id}/issue/", {
    params: { path: { id: order.id } },
    body: { on, lines: chosen.map((m) => ({ material: m.id, quantity: lines[m.id]!, batch_number: "" })) },
  })), props, "Materials issued to WIP", () => setOpen(false));
  return (
    <ActionDialog open={open} onOpenChange={openWithDefaults} trigger={props.trigger} title="Issue materials"
      description="Moves materials from the stores into work in progress against this order's reservations. Backflushed components are consumed when output is received."
      submitLabel="Issue to WIP" pending={issue.isPending} error={issue.error} disabled={!valid} onSubmit={() => issue.mutate(undefined)}>
      <Field id="issue-on" label="Posting date"><Input id="issue-on" type="date" className="h-10" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      {manual.length === 0 ? <p className="text-sm text-muted-foreground">All components are backflushed; nothing to issue by hand.</p> : manual.map((m) => (
        <Field key={m.id} id={`issue-${m.id}`} label={<span className="num">{m.item_code}</span>}
          hint={`Required ${qty(m.required_quantity)} · issued ${qty(m.issued_quantity)}`}>
          <Input id={`issue-${m.id}`} inputMode="decimal" className="num h-12 text-base" value={lines[m.id] ?? ""} onChange={(e) => setLines({ ...lines, [m.id]: e.target.value })} />
        </Field>
      ))}
    </ActionDialog>
  );
}

function ConfirmDialog({ order, operation, ...props }: ActionProps & { operation: ProductionOperation }) {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState("");
  const [quantity, setQuantity] = useState("0");
  const confirm = useOrderAction(() => unwrap(api.POST("/api/v1/manufacturing/orders/{id}/confirm/", {
    params: { path: { id: order.id } }, body: { operation: operation.id, minutes, quantity: quantity || "0" },
  })), props, `Time booked on ${operation.name}`, () => { setOpen(false); setMinutes(""); setQuantity("0"); });
  return (
    <ActionDialog open={open} onOpenChange={setOpen} trigger={props.trigger} title={`Confirm ${operation.sequence} · ${operation.name}`}
      description={`Book the minutes worked at ${operation.work_center_code}. Labour, machine and overhead cost follow from its hourly rates.`}
      submitLabel="Book time" pending={confirm.isPending} error={confirm.error}
      disabled={!isDecimal(minutes, { maxDp: 2, allowZero: false }) || !isDecimal(quantity || "0")} onSubmit={() => confirm.mutate(undefined)}>
      <div className="grid grid-cols-2 gap-4">
        <Field id="confirm-minutes" label="Minutes worked"><Input id="confirm-minutes" inputMode="decimal" className="num h-12 text-base" value={minutes} onChange={(e) => setMinutes(e.target.value)} autoFocus /></Field>
        <Field id="confirm-qty" label="Quantity completed"><Input id="confirm-qty" inputMode="decimal" className="num h-12 text-base" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
      </div>
      <p className="text-sm text-muted-foreground">Planned {qty(operation.planned_minutes)} min · booked so far {qty(operation.actual_minutes)} min.</p>
    </ActionDialog>
  );
}

function OutputDialog({ order, ...props }: ActionProps) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(today());
  const [quantity, setQuantity] = useState("");
  const [batch, setBatch] = useState("");
  const output = useOrderAction(() => unwrap(api.POST("/api/v1/manufacturing/orders/{id}/output/", {
    params: { path: { id: order.id } }, body: { on, quantity, batch_number: batch },
  })), props, "Output received", () => setOpen(false));
  return (
    <ActionDialog open={open} onOpenChange={(next) => { if (next) setQuantity(dec.max0(dec.sub(order.quantity, order.produced_quantity))); setOpen(next); }}
      trigger={props.trigger} title="Receive output"
      description="Consumes materials for this quantity and receives the finished goods at actual cost. The last receipt absorbs any remaining conversion cost."
      submitLabel="Receive output" pending={output.isPending} error={output.error} disabled={!isDecimal(quantity, { allowZero: false })} onSubmit={() => output.mutate(undefined)}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="output-qty" label={`Quantity of ${order.item_code}`}><Input id="output-qty" inputMode="decimal" className="num h-12 text-base" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
        <Field id="output-on" label="Posting date"><Input id="output-on" type="date" className="h-12" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      </div>
      <Field id="output-batch" label="Batch number" hint="Needed only for batch-tracked items."><Input id="output-batch" className="h-10" value={batch} onChange={(e) => setBatch(e.target.value)} /></Field>
    </ActionDialog>
  );
}

function ScrapDialog({ order, ...props }: ActionProps) {
  const [open, setOpen] = useState(false);
  const candidates = order.materials.filter((m) => dec.positive(inWip(m)));
  const [material, setMaterial] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [on, setOn] = useState(today());
  const scrap = useOrderAction(() => unwrap(api.POST("/api/v1/manufacturing/orders/{id}/scrap/", {
    params: { path: { id: order.id } }, body: { on, material, quantity, reason },
  })), props, "Scrap recorded", () => { setOpen(false); setQuantity(""); setReason(""); });
  return (
    <ActionDialog open={open} onOpenChange={(next) => { if (next && !material && candidates[0]) setMaterial(candidates[0].id); setOpen(next); }}
      trigger={props.trigger} title="Record scrap" description="Writes off issued material spoiled in process (from WIP to scrap expense)."
      submitLabel="Record scrap" destructive pending={scrap.isPending} error={scrap.error}
      disabled={!material || !isDecimal(quantity, { allowZero: false }) || !reason.trim()} onSubmit={() => scrap.mutate(undefined)}>
      <Field id="scrap-material" label="Material">
        <Select value={material} onValueChange={setMaterial}>
          <SelectTrigger id="scrap-material" className="h-12 w-full"><SelectValue placeholder={candidates.length ? "Choose" : "Nothing in WIP"} /></SelectTrigger>
          <SelectContent>{candidates.map((m) => <SelectItem key={m.id} value={m.id}>{m.item_code} · {qty(inWip(m))} in WIP</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="scrap-qty" label="Quantity"><Input id="scrap-qty" inputMode="decimal" className="num h-12 text-base" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
        <Field id="scrap-on" label="Posting date"><Input id="scrap-on" type="date" className="h-12" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      </div>
      <Field id="scrap-reason" label="Reason"><Input id="scrap-reason" className="h-10" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></Field>
    </ActionDialog>
  );
}

function CloseDialog({ order, ...props }: ActionProps) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(today());
  const leftover = order.materials.filter((m) => dec.positive(inWip(m)));
  const close = useOrderAction(() => unwrap(api.POST("/api/v1/manufacturing/orders/{id}/close/", {
    params: { path: { id: order.id } }, body: { on },
  })), props, "Order closed; the cost record is frozen", () => setOpen(false));
  return (
    <ActionDialog open={open} onOpenChange={setOpen} trigger={props.trigger} title={`Close ${order.number}`}
      description="Returns unused WIP to the stores, releases remaining reservations and freezes the cost record. This can't be undone."
      submitLabel="Close order" pending={close.isPending} error={close.error} onSubmit={() => close.mutate(undefined)}>
      <Field id="close-on" label="Posting date"><Input id="close-on" type="date" className="h-10" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      {leftover.length > 0 ? (
        <div className="rounded-md border px-3 py-2 text-sm">
          <p className="font-medium">Returned to stores</p>
          <ul className="mt-1 text-muted-foreground">{leftover.map((m) => <li key={m.id}><span className="num">{m.item_code}</span>: {qty(inWip(m))}</li>)}</ul>
        </div>
      ) : <p className="text-sm text-muted-foreground">Nothing is left in WIP.</p>}
    </ActionDialog>
  );
}

function AvailabilitySection({ order }: { order: ProductionOrder }) {
  const [asked, setAsked] = useState(false);
  const rows = useQuery({
    queryKey: ["manufacturing", "order", order.id, "availability"],
    queryFn: async () => (await unwrap(api.GET("/api/v1/manufacturing/orders/{id}/availability/", { params: { path: { id: order.id } } }))) as unknown as Availability[],
    enabled: asked,
  });
  const known = new Map(order.materials.map((m) => [m.item, m.item_code]));
  const unknownIds = [...new Set((rows.data ?? []).map((r) => r.item_id).filter((i) => !known.has(i)))];
  const items = useQueries({
    queries: unknownIds.map((itemId) => ({
      queryKey: ["masterdata", "item", itemId],
      queryFn: () => unwrap(api.GET("/api/v1/masterdata/items/{id}/", { params: { path: { id: itemId } } })),
      staleTime: 5 * 60_000,
    })),
  });
  items.forEach((q) => { if (q.data) known.set(q.data.id, q.data.code); });
  const short = (rows.data ?? []).filter((r) => dec.positive(r.shortage));
  return (
    <Section title="Material availability" description="Purchased components needed for the whole order (all BOM levels) against what's free in the issuing store."
      actions={<Button variant="outline" onClick={() => (asked ? rows.refetch() : setAsked(true))} disabled={rows.isFetching}><ClipboardCheck aria-hidden /> {asked ? "Check again" : "Check availability"}</Button>}>
      {rows.error && <ErrorState error={rows.error} />}
      {rows.data && (
        <>
          <p className="px-5 pt-3 text-sm">
            {short.length === 0 ? <StatusBadge tone="approved">Everything is available</StatusBadge> : <StatusBadge tone="rejected">{short.length} component{short.length === 1 ? "" : "s"} short</StatusBadge>}
          </p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow className="hover:bg-transparent">
                <TableHead>Component</TableHead><TableHead className="text-right">Required</TableHead><TableHead className="text-right">Available</TableHead><TableHead className="text-right">Shortage</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rows.data.map((r) => (
                  <TableRow key={r.item_id}>
                    <TableCell className="num font-medium">{known.get(r.item_id) ?? "…"}</TableCell>
                    <TableCell className="num text-right">{qty(r.required)}</TableCell>
                    <TableCell className="num text-right">{qty(r.available)}</TableCell>
                    <TableCell className={`num text-right ${dec.positive(r.shortage) ? "font-semibold text-status-rejected" : "text-muted-foreground"}`}>{qty(r.shortage)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </Section>
  );
}

function CostingSection({ costing }: { costing: Costing }) {
  const variance = costing.variance_per_unit;
  return (
    <Section title="Costing" description="Actual cost: materials consumed into output plus conversion booked through operations.">
      <div className="grid grid-cols-2 gap-3 p-5">
        <Figure label="Material" value={money(costing.material_cost)} />
        <Figure label="Conversion" value={money(costing.conversion_cost)} hint={`Labour ${money(costing.labour_cost)} · machine ${money(costing.machine_cost)} · overhead ${money(costing.overhead_cost)}`} />
        <Figure label="Total in output" value={money(costing.total_cost)} hint={`${qty(costing.produced_quantity)} produced`} />
        <Figure label="Unit cost" value={money(costing.unit_cost)} />
        <Figure label="Standard cost" value={dec.positive(costing.standard_cost) ? money(costing.standard_cost) : "Not set"} />
        <Figure label="Variance / unit" value={variance === null ? "—" : money(variance)}
          tone={variance === null ? undefined : dec.positive(variance) ? "bad" : "good"}
          hint={variance === null ? "Needs a standard cost" : dec.positive(variance) ? "Above standard" : "At or below standard"} />
      </div>
      <Facts className="border-t" items={[["Scrap written off", <span key="s" className="num">{money(costing.scrap_cost)}</span>], ["Conversion absorbed", <span key="a" className="num">{money(costing.absorbed_conversion)}</span>]]} />
    </Section>
  );
}

export function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const places = useOrgPlaces();
  const queryClient = useQueryClient();
  const key = ["manufacturing", "order", id];
  const query = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/api/v1/manufacturing/orders/{id}/", { params: { path: { id } } })) });
  const onDone = (order: ProductionOrder, message: string) => {
    queryClient.setQueryData(key, order);
    queryClient.invalidateQueries({ queryKey: ["manufacturing", "orders"] });
    queryClient.invalidateQueries({ queryKey: ["collaboration", "activity"] });
    toast(message);
  };
  const onFail = () => queryClient.invalidateQueries({ queryKey: key });
  const release = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/manufacturing/orders/{id}/release/", { params: { path: { id } } })),
    onSuccess: (order) => onDone(order, `Released as ${order.number}; materials reserved`),
    onError: onFail,
  });

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const o = query.data!;
  const active = o.status === "released" || o.status === "in_progress";
  const closable = active || o.status === "completed";
  const costing = o.costing as unknown as Costing;
  const props = { order: o, onDone, onFail };
  const P = "manufacturing.production_order";

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Production orders", href: "/manufacturing/orders" }, { label: o.number || "Draft order" }]}
        title={<span className="num">{o.number || "Draft order"} · {o.item_code}</span>}
        meta={<>
          <StateBadge kind="order" value={o.status} />
          <span className="num text-base font-semibold">{qty(o.produced_quantity)} / {qty(o.quantity)} made</span>
          {dec.positive(o.scrapped_quantity) && <span className="num text-muted-foreground">{qty(o.scrapped_quantity)} scrapped</span>}
          <span className="text-muted-foreground">{date(o.planned_start)} – {date(o.planned_end)}</span>
        </>}
      />

      <Section title="Shop floor" className="mb-6">
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {o.status === "draft" && can(`${P}.release`) && (
            <FloorButton onClick={() => release.mutate()} disabled={release.isPending}><Play aria-hidden /> Release and reserve materials</FloorButton>
          )}
          {active && can(`${P}.issue`) && <IssueDialog {...props} trigger={<FloorButton variant="outline"><PackageMinus aria-hidden /> Issue materials</FloorButton>} />}
          {active && can(`${P}.receive`) && <OutputDialog {...props} trigger={<FloorButton><PackageCheck aria-hidden /> Receive output</FloorButton>} />}
          {active && can(`${P}.confirm`) && <ScrapDialog {...props} trigger={<FloorButton variant="outline"><Trash aria-hidden /> Record scrap</FloorButton>} />}
          {closable && can(`${P}.close`) && <CloseDialog {...props} trigger={<FloorButton variant="outline"><Lock aria-hidden /> Close order</FloorButton>} />}
          {!active && !closable && o.status !== "draft" && <p className="text-sm text-muted-foreground">This order is {o.status}. No further shop-floor actions.</p>}
        </div>
        {release.error && <div className="px-5 pb-4"><FormError message={problemMessage(release.error)} /></div>}
      </Section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 content-start gap-6">
          {o.status === "draft" && <AvailabilitySection order={o} />}
          <Section title="Materials" description={o.materials.length ? "Frozen from the BOM at release." : "Materials are frozen from the BOM when the order is released."}>
            {o.materials.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow className="hover:bg-transparent">
                    <TableHead>Component</TableHead><TableHead className="text-right">Required</TableHead><TableHead className="text-right">Issued</TableHead>
                    <TableHead className="text-right">Consumed</TableHead><TableHead className="text-right">Returned</TableHead><TableHead className="text-right">In WIP</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {o.materials.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell><span className="num block font-medium">{m.item_code}</span><span className="block text-xs text-muted-foreground">{m.issue_method === "backflush" ? "Backflush" : "Manual issue"}</span></TableCell>
                        <TableCell className="num text-right">{qty(m.required_quantity)}</TableCell>
                        <TableCell className="num text-right">{qty(m.issued_quantity)}</TableCell>
                        <TableCell className="num text-right">{qty(m.consumed_quantity)}</TableCell>
                        <TableCell className="num text-right">{qty(m.returned_quantity)}</TableCell>
                        <TableCell className="num text-right font-medium">{qty(inWip(m))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>
          <Section title="Operations" description={o.operations.length ? "Book minutes and quantity per operation." : "The routing is frozen into the order at release."}>
            {o.operations.length > 0 && (
              <ul className="divide-y">
                {o.operations.map((op) => (
                  <li key={op.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium"><span className="num">{op.sequence}</span> · {op.name} <span className="num text-sm font-normal text-muted-foreground">@ {op.work_center_code}</span></p>
                      <p className="num text-sm text-muted-foreground">{qty(op.actual_minutes)} of {qty(op.planned_minutes)} min · {qty(op.completed_quantity)} done</p>
                    </div>
                    {active && can(`${P}.confirm`) && (
                      <ConfirmDialog {...props} operation={op} trigger={<Button size="lg" className="h-12 px-5 text-base"><Timer aria-hidden /> Confirm {op.sequence}</Button>} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <CostingSection costing={costing} />
          <Section title="Order">
            <Facts items={[
              ["Facility", places.label(o.facility)],
              ["Issue from", places.label(o.source_warehouse)],
              ["WIP", places.label(o.wip_warehouse)],
              ["Output to", places.label(o.output_warehouse)],
              ["Kind", o.kind === "rework" ? "Rework" : "Standard"],
            ]} />
          </Section>
          <RecordPanel resourceType="manufacturing.production_order" resourceId={o.id} />
        </div>
      </div>
    </>
  );
}
