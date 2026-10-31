"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, GitBranch, Plus, Trash2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState, ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionDialog } from "@/components/production/action-dialog";
import { ItemPicker, type ItemRef } from "@/components/production/pickers";
import { StateBadge } from "@/components/production/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import {
  isDecimal, problemMessage, qty, today, usePersonLabel, type Bom, type BomVersion, type ExplosionNode,
} from "@/lib/api/production";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

type ComponentRow = { key: number; item: ItemRef | null; quantity: string; scrap_pct: string; issue_method: "manual" | "backflush" };
type OperationRow = { key: number; sequence: string; name: string; work_center_code: string; setup_minutes: string; run_minutes_per_unit: string };

let rowKey = 0;
const newComponent = (): ComponentRow => ({ key: ++rowKey, item: null, quantity: "1", scrap_pct: "0", issue_method: "manual" });
const newOperation = (sequence: number): OperationRow => ({ key: ++rowKey, sequence: String(sequence), name: "", work_center_code: "", setup_minutes: "0", run_minutes_per_unit: "0" });

function NewVersion({ bom, onCreated }: { bom: Bom; onCreated: (bom: Bom) => void }) {
  const [open, setOpen] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [output, setOutput] = useState("1");
  const [notes, setNotes] = useState("");
  const [components, setComponents] = useState<ComponentRow[]>([newComponent()]);
  const [operations, setOperations] = useState<OperationRow[]>([]);
  const workCenters = useQuery({
    queryKey: ["manufacturing", "work-centers", "all"],
    queryFn: () => unwrap(api.GET("/api/v1/manufacturing/work-centers/", { params: { query: { is_active: true, page_size: 200 } } })),
    enabled: open,
  });
  const codes = [...new Set((workCenters.data?.results ?? []).map((w) => w.code))];
  const create = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/api/v1/manufacturing/boms/{id}/versions/", {
        params: { path: { id: bom.id } },
        body: {
          effective_from: effectiveFrom,
          output_quantity: output,
          notes,
          components: components.map((c) => ({ item: c.item!.id, quantity: c.quantity, scrap_pct: c.scrap_pct || "0", issue_method: c.issue_method })),
          operations: operations.map((o) => ({
            sequence: Number(o.sequence), name: o.name, work_center_code: o.work_center_code,
            setup_minutes: o.setup_minutes || "0", run_minutes_per_unit: o.run_minutes_per_unit || "0",
          })),
        },
      })),
    onSuccess: (fresh) => {
      onCreated(fresh);
      toast("Draft version created. Another person must approve it.");
      setOpen(false);
      setComponents([newComponent()]);
      setOperations([]);
      setNotes("");
    },
  });
  const componentsValid = components.length > 0 && components.every((c) => c.item && isDecimal(c.quantity, { allowZero: false }) && isDecimal(c.scrap_pct || "0", { maxDp: 4 }));
  const operationsValid = operations.every((o) => /^\d+$/.test(o.sequence) && o.name && o.work_center_code && isDecimal(o.setup_minutes || "0", { maxDp: 2 }) && isDecimal(o.run_minutes_per_unit || "0", { maxDp: 4 }));
  const valid = componentsValid && operationsValid && isDecimal(output, { allowZero: false }) && !!effectiveFrom;
  const setC = (key: number, patch: Partial<ComponentRow>) => setComponents((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const setO = (key: number, patch: Partial<OperationRow>) => setOperations((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <ActionDialog wide open={open} onOpenChange={setOpen} trigger={<Button><Plus aria-hidden /> New version</Button>}
      title={`New version of ${bom.code}`} description="Quantities are in each component's stock unit, per the output quantity below. The version starts as a draft."
      submitLabel="Create draft version" pending={create.isPending} error={create.error} disabled={!valid} onSubmit={() => create.mutate()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="v-effective" label="Effective from"><Input id="v-effective" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required /></Field>
        <Field id="v-output" label="Output quantity" hint={`Units of ${bom.item_code} the components make.`}><Input id="v-output" inputMode="decimal" className="num" value={output} onChange={(e) => setOutput(e.target.value)} /></Field>
      </div>
      <fieldset className="grid min-w-0 gap-3">
        <legend className="mb-2 text-sm font-medium">Components</legend>
        {components.map((c, index) => (
          <div key={c.key} className="grid min-w-0 gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,2fr)_6rem_5rem_8rem_auto] sm:items-end">
            <Field id={`c-item-${c.key}`} label={`Component ${index + 1}`}>
              <ItemPicker id={`c-item-${c.key}`} value={c.item} onChange={(item) => setC(c.key, { item })} />
            </Field>
            <Field id={`c-qty-${c.key}`} label="Quantity"><Input id={`c-qty-${c.key}`} inputMode="decimal" className="num h-10" value={c.quantity} onChange={(e) => setC(c.key, { quantity: e.target.value })} /></Field>
            <Field id={`c-scrap-${c.key}`} label="Scrap %"><Input id={`c-scrap-${c.key}`} inputMode="decimal" className="num h-10" value={c.scrap_pct} onChange={(e) => setC(c.key, { scrap_pct: e.target.value })} /></Field>
            <Field id={`c-method-${c.key}`} label="Issue">
              <Select value={c.issue_method} onValueChange={(v) => setC(c.key, { issue_method: v as ComponentRow["issue_method"] })}>
                <SelectTrigger id={`c-method-${c.key}`} className="h-10 w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="manual">Manual issue</SelectItem><SelectItem value="backflush">Backflush</SelectItem></SelectContent>
              </Select>
            </Field>
            <Button type="button" variant="ghost" size="icon-lg" aria-label={`Remove component ${index + 1}`} disabled={components.length === 1}
              onClick={() => setComponents((rows) => rows.filter((r) => r.key !== c.key))}><Trash2 aria-hidden /></Button>
          </div>
        ))}
        <Button type="button" variant="outline" className="justify-self-start" onClick={() => setComponents((rows) => [...rows, newComponent()])}><Plus aria-hidden /> Add component</Button>
      </fieldset>
      <fieldset className="grid min-w-0 gap-3">
        <legend className="mb-2 text-sm font-medium">Routing operations <span className="font-normal text-muted-foreground">(optional)</span></legend>
        {operations.map((o, index) => (
          <div key={o.key} className="grid min-w-0 grid-cols-2 gap-2 rounded-md border p-3 sm:grid-cols-[4rem_minmax(0,2fr)_minmax(0,1.4fr)_5rem_6rem_auto] sm:items-end">
            <Field id={`o-seq-${o.key}`} label="Seq."><Input id={`o-seq-${o.key}`} inputMode="numeric" className="num h-10" value={o.sequence} onChange={(e) => setO(o.key, { sequence: e.target.value })} /></Field>
            <Field id={`o-name-${o.key}`} label={`Operation ${index + 1}`}><Input id={`o-name-${o.key}`} className="h-10" value={o.name} onChange={(e) => setO(o.key, { name: e.target.value })} /></Field>
            <Field id={`o-wc-${o.key}`} label="Work centre" className="col-span-2 sm:col-span-1">
              <Select value={o.work_center_code} onValueChange={(v) => setO(o.key, { work_center_code: v })}>
                <SelectTrigger id={`o-wc-${o.key}`} className="h-10 w-full"><SelectValue placeholder={codes.length ? "Choose" : "No work centres"} /></SelectTrigger>
                <SelectContent>{codes.map((code) => <SelectItem key={code} value={code}>{code}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field id={`o-setup-${o.key}`} label="Setup min"><Input id={`o-setup-${o.key}`} inputMode="decimal" className="num h-10" value={o.setup_minutes} onChange={(e) => setO(o.key, { setup_minutes: e.target.value })} /></Field>
            <Field id={`o-run-${o.key}`} label="Run min/unit"><Input id={`o-run-${o.key}`} inputMode="decimal" className="num h-10" value={o.run_minutes_per_unit} onChange={(e) => setO(o.key, { run_minutes_per_unit: e.target.value })} /></Field>
            <Button type="button" variant="ghost" size="icon-lg" aria-label={`Remove operation ${index + 1}`} onClick={() => setOperations((rows) => rows.filter((r) => r.key !== o.key))}><Trash2 aria-hidden /></Button>
          </div>
        ))}
        <Button type="button" variant="outline" className="justify-self-start" onClick={() => setOperations((rows) => [...rows, newOperation((rows.length + 1) * 10)])}><Plus aria-hidden /> Add operation</Button>
      </fieldset>
      <Field id="v-notes" label="Notes"><Textarea id="v-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </ActionDialog>
  );
}

function VersionCard({ bom, version, onChanged }: { bom: Bom; version: BomVersion; onChanged: (bom: Bom) => void }) {
  const { can, me } = useSession();
  const person = usePersonLabel();
  const approve = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/manufacturing/boms/{id}/versions/{version_id}/approve/", { params: { path: { id: bom.id, version_id: version.id } } })),
    onSuccess: (fresh) => { onChanged(fresh); toast(`Version ${version.version_no} approved`); },
  });
  const mine = version.created_by === me.user.id;
  const operations = version.operations ?? [];
  return (
    <Section
      title={<span className="flex flex-wrap items-center gap-2">Version {version.version_no} <StateBadge kind="bomVersion" value={version.status} /></span>}
      description={`Effective ${date(version.effective_from)}${version.effective_to ? ` to ${date(version.effective_to)}` : ""} · makes ${qty(version.output_quantity)} ${bom.item_code}`}
      actions={version.status === "draft" && can("manufacturing.bom.approve") && (
        <div className="grid justify-items-end gap-1">
          <Button onClick={() => approve.mutate()} disabled={approve.isPending || mine} aria-describedby={mine ? `self-${version.id}` : undefined}>
            <Check aria-hidden /> Approve version {version.version_no}
          </Button>
          {mine && <p id={`self-${version.id}`} className="max-w-[34ch] text-right text-xs text-muted-foreground">You drafted this version, so another person must approve it.</p>}
        </div>
      )}
    >
      {approve.error && <div className="px-5 pt-4"><FormError message={problemMessage(approve.error)} /></div>}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent">
            <TableHead className="w-10">#</TableHead><TableHead>Component</TableHead><TableHead className="text-right">Quantity</TableHead>
            <TableHead className="text-right">Scrap %</TableHead><TableHead>Issue</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {version.components.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="num text-muted-foreground">{c.line_no}</TableCell>
                <TableCell className="num font-medium">{c.item_code}</TableCell>
                <TableCell className="num text-right">{qty(c.quantity)}</TableCell>
                <TableCell className="num text-right">{qty(c.scrap_pct)}</TableCell>
                <TableCell>{c.issue_method === "backflush" ? "Backflush" : "Manual"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {operations.length > 0 && (
        <div className="overflow-x-auto border-t">
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent">
              <TableHead className="w-14">Seq.</TableHead><TableHead>Operation</TableHead><TableHead>Work centre</TableHead>
              <TableHead className="text-right">Setup min</TableHead><TableHead className="text-right">Run min/unit</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {operations.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="num">{o.sequence}</TableCell><TableCell>{o.name}</TableCell><TableCell className="num">{o.work_center_code}</TableCell>
                  <TableCell className="num text-right">{qty(o.setup_minutes)}</TableCell><TableCell className="num text-right">{qty(o.run_minutes_per_unit)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="border-t px-5 py-2.5 text-xs text-muted-foreground">
        Drafted by {person(version.created_by)}{version.approved_by && <> · approved by {person(version.approved_by, "another person")}</>}
        {version.notes && <> · {version.notes}</>}
      </p>
    </Section>
  );
}

function TreeNode({ node, depth }: { node: ExplosionNode; depth: number }) {
  return (
    <li>
      <div className="flex min-w-0 items-center gap-2 border-b py-2 text-sm" style={{ paddingLeft: `${depth * 1.25}rem` }}>
        {depth > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="num truncate font-medium">{node.item_code}</span>
        {!node.leaf && node.bom_version !== undefined && <span className="text-xs text-muted-foreground">BOM v{node.bom_version}</span>}
        <span className="num ml-auto shrink-0">{qty(node.quantity)}</span>
      </div>
      {node.children.length > 0 && <ul>{node.children.map((child, i) => <TreeNode key={`${child.item_id}-${i}`} node={child} depth={depth + 1} />)}</ul>}
    </li>
  );
}

function Explosion({ bom }: { bom: Bom }) {
  const [quantity, setQuantity] = useState("1");
  const [on, setOn] = useState(today());
  const [asked, setAsked] = useState<{ quantity: string; on: string } | null>(null);
  const tree = useQuery({
    queryKey: ["manufacturing", "boms", bom.id, "explosion", asked],
    queryFn: () => unwrap(api.GET("/api/v1/manufacturing/boms/{id}/explosion/", { params: { path: { id: bom.id }, query: { quantity: asked!.quantity, on: asked!.on } } })),
    enabled: asked !== null,
  });
  const root = tree.data?.tree as unknown as ExplosionNode | undefined;
  return (
    <Section title="Multi-level explosion" description="Walks the approved versions effective on the date, down through sub-assemblies.">
      <form className="flex flex-wrap items-end gap-3 px-5 py-4" onSubmit={(e) => { e.preventDefault(); if (isDecimal(quantity, { allowZero: false })) setAsked({ quantity, on }); }}>
        <Field id="x-qty" label={`Quantity of ${bom.item_code}`}><Input id="x-qty" inputMode="decimal" className="num h-10 w-32" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
        <Field id="x-on" label="On"><Input id="x-on" type="date" className="h-10" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
        <Button type="submit" variant="outline" className="h-10" disabled={!isDecimal(quantity, { allowZero: false })}><GitBranch aria-hidden /> Explode</Button>
      </form>
      {tree.error && <ErrorState error={tree.error} />}
      {root && (
        root.leaf
          ? <p className="px-5 pb-4 text-sm text-muted-foreground">No approved version is effective on that date.</p>
          : <ul className="px-5 pb-4" aria-label="Explosion tree"><TreeNode node={root} depth={0} /></ul>
      )}
    </Section>
  );
}

export function BomDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const key = ["manufacturing", "bom", id];
  const query = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/api/v1/manufacturing/boms/{id}/", { params: { path: { id } } })) });
  const onChanged = (fresh: Bom) => {
    queryClient.setQueryData(key, fresh);
    queryClient.invalidateQueries({ queryKey: ["manufacturing", "boms"] });
  };
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const bom = query.data!;
  const versions = [...bom.versions].sort((a, b) => b.version_no - a.version_no);
  return (
    <>
      <PageHeader crumbs={[{ label: "Bills of materials", href: "/manufacturing/boms" }, { label: bom.code }]}
        title={bom.name}
        meta={<><span className="num font-medium">{bom.code}</span><span className="text-muted-foreground">Makes <span className="num">{bom.item_code}</span></span><ActiveStatus active={bom.is_active ?? true} /></>}
        actions={can("manufacturing.bom.update") && <NewVersion bom={bom} onCreated={onChanged} />} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid content-start gap-6">
          {versions.length === 0
            ? <Section><EmptyState icon={GitBranch} title="No versions yet" description="Add the first version with its components and routing." /></Section>
            : versions.map((v) => <VersionCard key={v.id} bom={bom} version={v} onChanged={onChanged} />)}
        </div>
        <div className="grid content-start gap-6"><Explosion bom={bom} /></div>
      </div>
    </>
  );
}
