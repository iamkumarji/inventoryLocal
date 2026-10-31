"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, ClipboardCheck, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { ActionError, ANY, Facts, FilterBar, ItemPicker, WarehouseSelect, Who, type ItemOption, useSeedOnOpen } from "@/components/inventory/bits";
import { dec, isDecimal, qty } from "@/components/inventory/decimal";
import { bannerError, fieldErrors } from "@/components/inventory/problem";
import { InvStatus } from "@/components/inventory/status";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { DISPOSITIONS, STAGES, useItem, useWarehouses, type Inspection, type NCR, type Plan, type PlanParameter } from "@/lib/api/inventory";
import { ago, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";

const SOURCE_LABELS: Record<string, string> = {
  "procurement.goods_receipt": "Goods receipt",
  "manufacturing.production_order": "Production output",
};

function ItemCode({ id }: { id: string }) {
  const item = useItem(id);
  return <span className="num">{item.data?.code ?? "…"}</span>;
}

/* ---------------------------------------------------------------- Inspections */

type Result = { name: string; value: string; passed: boolean | null };

function DecideSheet({ inspectionId, onClose }: { inspectionId: string | null; onClose: () => void }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const wh = useWarehouses({ activeCompanyOnly: false });
  const query = useQuery({
    queryKey: ["quality", "inspection", inspectionId],
    queryFn: () => unwrap(api.GET("/api/v1/quality/inspections/{id}/", { params: { path: { id: inspectionId! } } })),
    enabled: !!inspectionId,
  });
  const ins = query.data;
  const plan = useQuery({
    queryKey: ["quality", "plan", ins?.plan],
    queryFn: () => unwrap(api.GET("/api/v1/quality/plans/{id}/", { params: { path: { id: ins!.plan! } } })),
    enabled: !!ins?.plan && can("quality.inspection_plan.read"),
  });
  const parameters = ((plan.data?.parameters as PlanParameter[] | undefined) ?? []);

  const [seeded, setSeeded] = useState<string | null>(null);
  const [form, setForm] = useState({ accepted: "", rejected: "0", remarks: "", ncr: "" });
  const [results, setResults] = useState<Result[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const seedKey = ins ? `${ins.id}:${ins.version}:${parameters.length}` : null;
  if (ins && seedKey !== seeded) {
    setSeeded(seedKey);
    setForm({ accepted: dec.normalize(ins.quantity), rejected: "0", remarks: "", ncr: "" });
    setResults(parameters.map((p) => ({ name: p.name, value: "", passed: null })));
    setLocalError(null);
  }

  const decide = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/quality/inspections/{id}/decide/", {
      params: { path: { id: inspectionId! } },
      body: {
        accepted_quantity: dec.normalize(form.accepted), rejected_quantity: dec.normalize(form.rejected), remarks: form.remarks, ncr_description: form.ncr,
        results: results.filter((r) => r.value !== "" || r.passed !== null).map((r) => ({ name: r.name, value: r.value || null, passed: r.passed })),
        version: ins!.version,
      },
    })),
    onSuccess: (done) => {
      queryClient.setQueryData(["quality", "inspection", inspectionId], done);
      queryClient.invalidateQueries({ queryKey: ["quality"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      const parts = [!dec.isZero(done.accepted_quantity) && `${qty(done.accepted_quantity)} released to stock`, !dec.isZero(done.rejected_quantity) && `${qty(done.rejected_quantity)} blocked`].filter(Boolean);
      toast(`${done.number}: ${parts.join(", ")}${dec.isZero(done.rejected_quantity) ? "" : "; an NCR was opened"}`);
    },
    onError: (error) => { if (isApiError(error, "version_conflict") || isApiError(error, "invalid_state_transition")) query.refetch(); },
  });

  const setAccepted = (v: string) => {
    // Keep the two quantities adding up to the inspected quantity while the user types.
    const rejected = ins && isDecimal(v) && dec.cmp(v, ins.quantity) <= 0 && !dec.isNegative(v) ? dec.sub(ins.quantity, v) : form.rejected;
    setForm({ ...form, accepted: v, rejected });
  };
  const rejecting = isDecimal(form.rejected) && dec.cmp(form.rejected, "0") > 0;
  const submit = () => {
    if (!ins) return;
    let problem: string | null = null;
    if (!isDecimal(form.accepted) || !isDecimal(form.rejected) || dec.isNegative(form.accepted) || dec.isNegative(form.rejected)) problem = "Enter accepted and rejected quantities of zero or more.";
    else if (dec.cmp(dec.add(form.accepted, form.rejected), ins.quantity) !== 0) problem = `Accepted plus rejected must equal the inspected quantity (${qty(ins.quantity)}).`;
    else if (rejecting && !form.remarks.trim() && !form.ncr.trim()) problem = "Say why material was rejected.";
    setLocalError(problem);
    if (!problem) decide.mutate();
  };
  const e = fieldErrors(decide.error);
  const pending = ins?.status === "pending";
  const canDecide = pending && can("quality.inspection.approve");
  const decidedResults = (ins?.results as Array<{ name: string; value?: string | null; passed?: boolean }> | undefined) ?? [];

  return (
    <Sheet open={!!inspectionId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{ins ? <span className="num">{ins.number}</span> : "Inspection"}</SheetTitle>
          <SheetDescription>Accepted quantity is released to unrestricted stock; rejected quantity is blocked and opens a non-conformance report.</SheetDescription>
        </SheetHeader>
        <div className="grid gap-5 px-4 pb-6">
          {query.isLoading ? <RowsSkeleton rows={5} /> : query.error ? <ErrorState error={query.error} onRetry={query.refetch} /> : ins && (
            <>
              <Facts items={[
                ["Status", <InvStatus key="s" kind="inspection" status={ins.status} />],
                ["Item", <ItemCode key="i" id={ins.item} />],
                ["Quantity on hold", <span key="q" className="num font-semibold">{qty(ins.quantity)}</span>],
                ["Stage", STAGES[ins.stage] ?? ins.stage],
                ["Warehouse", <span key="w" className="num">{wh.label(ins.warehouse)}</span>],
                ["Source", SOURCE_LABELS[ins.source_type] ?? ins.source_type],
                ins.supplier_name ? ["Supplier", ins.supplier_name] : null,
                ["Plan", ins.plan ? `${parameters.length} parameter${parameters.length === 1 ? "" : "s"}${plan.data?.sample_size ? `, sample ${plan.data.sample_size}` : ""}` : "No plan"],
                !pending && ["Accepted", <span key="a" className="num">{qty(ins.accepted_quantity)}</span>],
                !pending && ["Rejected", <span key="r" className="num">{qty(ins.rejected_quantity)}</span>],
                !pending && ["Decided", <span key="d">{dateTime(ins.decided_at)} by <Who id={ins.inspected_by} /></span>],
                ins.remarks ? ["Remarks", ins.remarks] : null,
              ]} />
              {!pending && decidedResults.length > 0 && (
                <ul className="divide-y rounded-md border text-sm">
                  {decidedResults.map((r, i) => (
                    <li key={i} className="flex items-center justify-between px-3 py-2">
                      <span>{r.name}{r.value ? <span className="num text-muted-foreground"> {r.value}</span> : null}</span>
                      <span className={r.passed ? "text-status-approved" : "text-status-rejected"}>{r.passed ? "In tolerance" : "Out of tolerance"}</span>
                    </li>
                  ))}
                </ul>
              )}
              {canDecide && (
                <form className="grid gap-4" onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
                  {parameters.length > 0 && (
                    <fieldset className="grid gap-3">
                      <legend className="mb-1 text-sm font-medium">Measurements</legend>
                      {parameters.map((p, i) => (
                        <div key={p.name} className="grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-3">
                          <Label htmlFor={`res-${i}`} className="font-normal">
                            {p.name}
                            {p.kind === "numeric" && <span className="num block text-xs text-muted-foreground">{p.min ?? "−∞"} to {p.max ?? "∞"} {p.unit}</span>}
                          </Label>
                          {p.kind === "numeric" ? (
                            <Input id={`res-${i}`} inputMode="decimal" className="num" value={results[i]?.value ?? ""}
                              onChange={(ev) => setResults(results.map((r, j) => (j === i ? { ...r, value: ev.target.value } : r)))} />
                          ) : (
                            <Select value={results[i]?.passed === null || results[i] === undefined ? "" : results[i].passed ? "pass" : "fail"}
                              onValueChange={(v) => setResults(results.map((r, j) => (j === i ? { ...r, passed: v === "pass" } : r)))}>
                              <SelectTrigger id={`res-${i}`} className="w-full"><SelectValue placeholder="Result" /></SelectTrigger>
                              <SelectContent><SelectItem value="pass">Pass</SelectItem><SelectItem value="fail">Fail</SelectItem></SelectContent>
                            </Select>
                          )}
                        </div>
                      ))}
                    </fieldset>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <Field id="dec-acc" label="Accepted" error={e.accepted_quantity}>
                      <Input id="dec-acc" inputMode="decimal" className="num" value={form.accepted} onChange={(ev) => setAccepted(ev.target.value)} />
                    </Field>
                    <Field id="dec-rej" label="Rejected" error={e.rejected_quantity}>
                      <Input id="dec-rej" inputMode="decimal" className="num" value={form.rejected} onChange={(ev) => setForm({ ...form, rejected: ev.target.value })} />
                    </Field>
                  </div>
                  <Field id="dec-remarks" label="Remarks" error={e.remarks} hint={rejecting ? "Required when anything is rejected." : undefined}>
                    <Textarea id="dec-remarks" rows={2} value={form.remarks} onChange={(ev) => setForm({ ...form, remarks: ev.target.value })} />
                  </Field>
                  {rejecting && (
                    <Field id="dec-ncr" label="Non-conformance description" hint="Opens an NCR. Defaults to the remarks.">
                      <Textarea id="dec-ncr" rows={2} value={form.ncr} onChange={(ev) => setForm({ ...form, ncr: ev.target.value })} />
                    </Field>
                  )}
                  {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
                  <ActionError error={bannerError(decide.error)} denied="You can't decide inspections in this warehouse." />
                  <Button type="submit" disabled={decide.isPending}>Record decision</Button>
                </form>
              )}
              {pending && !can("quality.inspection.approve") && <p className="text-sm text-muted-foreground">A quality inspector decides this inspection.</p>}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Inspections() {
  const url = useUrlState();
  const { can } = useSession();
  const wh = useWarehouses({ activeCompanyOnly: false });
  const status = url.get("status") || "pending";
  const stage = url.get("stage");
  const warehouse = url.get("warehouse");
  const query = useQuery({
    queryKey: ["quality", "inspections", status, stage, warehouse, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/quality/inspections/", {
      params: { query: { status: (status === "all" ? undefined : status) as never, stage: (stage || undefined) as never, warehouse: warehouse || undefined, page: url.page } },
    })),
  });
  const open = (id: string) => url.set({ inspection: id });
  const columns: Column<Inspection>[] = [
    { key: "num", header: "Inspection", cell: (i) => (
      <button type="button" className="num text-left font-medium underline-offset-4 hover:underline" onClick={() => open(i.id)} aria-label={`Open inspection ${i.number}`}>{i.number}</button>
    ) },
    { key: "item", header: "Item", cell: (i) => <span className="num">{i.item_code}</span> },
    { key: "qty", header: "Quantity", align: "right", cell: (i) => <span className="num">{qty(i.quantity)}</span> },
    { key: "stage", header: "Stage", cell: (i) => STAGES[i.stage] ?? i.stage },
    { key: "wh", header: "Warehouse", cell: (i) => <span className="num">{wh.label(i.warehouse)}</span> },
    { key: "src", header: "From", cell: (i) => <span className="text-muted-foreground">{i.supplier_name || SOURCE_LABELS[i.source_type] || i.source_type}</span> },
    { key: "status", header: "Status", cell: (i) => <InvStatus kind="inspection" status={i.status} /> },
    { key: "age", header: "Waiting", cell: (i) => <span className="whitespace-nowrap text-muted-foreground">{i.status === "pending" ? ago(i.created_at) : dateTime(i.decided_at)}</span> },
    ...(can("quality.inspection.approve") ? [{ key: "act", header: <span className="sr-only">Action</span>, align: "right" as const, cell: (i: Inspection) => (
      i.status === "pending" ? <Button size="sm" onClick={() => open(i.id)}>Decide</Button> : null
    ) }] : []),
  ];
  return (
    <Section
      actions={
        <FilterBar>
          <Select value={status} onValueChange={(v) => url.set({ status: v === "pending" ? null : v })}>
            <SelectTrigger className="w-full sm:w-44" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Waiting for decision</SelectItem>
              <SelectItem value="accepted">Accepted</SelectItem>
              <SelectItem value="partially_accepted">Partly accepted</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <Select value={stage || ANY} onValueChange={(v) => url.set({ stage: v === ANY ? null : v })}>
            <SelectTrigger className="w-full sm:w-36" aria-label="Stage"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ANY}>Any stage</SelectItem>{Object.entries(STAGES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
          </Select>
          <WarehouseSelect value={warehouse} onChange={(v) => url.set({ warehouse: v })} allowAny className="sm:w-44" ariaLabel="Warehouse" />
        </FilterBar>
      }
    >
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch} caption="Inspections"
        empty={<EmptyState icon={ClipboardCheck} title={status === "pending" ? "Nothing waiting for inspection" : "No inspections match"}
          description="Goods receipts and production output of items marked for inspection arrive here on quality hold." />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
    </Section>
  );
}

/* ---------------------------------------------------------------- NCRs */

function CloseNcr({ ncr, onDone }: { ncr: NCR | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [d, setD] = useState({ disposition: "", corrective_action: "" });
  const [seen, setSeen] = useState<NCR | null>(null);
  if (ncr && seen !== ncr) { setSeen(ncr); setD({ disposition: "", corrective_action: "" }); }
  const close = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/quality/ncrs/{id}/close/", { params: { path: { id: ncr!.id } }, body: { disposition: d.disposition as never, corrective_action: d.corrective_action } })),
    onSuccess: (n) => { queryClient.invalidateQueries({ queryKey: ["quality", "ncrs"] }); toast(`${n.number} closed`); onDone(); },
  });
  const e = fieldErrors(close.error);
  return (
    <Dialog open={!!ncr} onOpenChange={(o) => !o && onDone()}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(ev) => { ev.preventDefault(); close.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Close <span className="num">{ncr?.number}</span></DialogTitle>
            <DialogDescription>{ncr?.description}</DialogDescription>
          </DialogHeader>
          <ActionError error={bannerError(close.error)} denied="You can't close non-conformance reports." />
          <Field id="ncr-disp" label="Disposition" error={e.disposition}>
            <Select value={d.disposition} onValueChange={(v) => setD({ ...d, disposition: v })}>
              <SelectTrigger id="ncr-disp" className="w-full"><SelectValue placeholder="What happens to the material" /></SelectTrigger>
              <SelectContent>{Object.entries(DISPOSITIONS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="ncr-ca" label="Corrective action" error={e.corrective_action}>
            <Textarea id="ncr-ca" rows={3} value={d.corrective_action} onChange={(ev) => setD({ ...d, corrective_action: ev.target.value })} required />
          </Field>
          <DialogFooter><Button type="submit" disabled={close.isPending || !d.disposition || !d.corrective_action.trim()}>Close NCR</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Ncrs() {
  const url = useUrlState();
  const { can } = useSession();
  const status = url.get("ncr") || "open";
  const [closing, setClosing] = useState<NCR | null>(null);
  const query = useQuery({
    queryKey: ["quality", "ncrs", status, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/quality/ncrs/", { params: { query: { status: (status === "all" ? undefined : status) as never, page: url.page } } })),
  });
  const columns: Column<NCR>[] = [
    { key: "num", header: "NCR", cell: (n) => <span className="num font-medium">{n.number}</span> },
    { key: "desc", header: "Description", cell: (n) => <span className="block max-w-[40ch] truncate">{n.description}</span> },
    { key: "insp", header: "Inspection", cell: (n) => (
      <button type="button" className="underline-offset-4 hover:underline" onClick={() => url.set({ inspection: n.inspection })}>Open</button>
    ) },
    { key: "disp", header: "Disposition", cell: (n) => (n.disposition ? DISPOSITIONS[n.disposition] : <span className="text-muted-foreground">—</span>) },
    { key: "status", header: "Status", cell: (n) => <InvStatus kind="ncr" status={n.status} /> },
    { key: "age", header: "Raised", cell: (n) => <span className="whitespace-nowrap text-muted-foreground">{ago(n.created_at)}</span> },
    ...(can("quality.ncr.update") ? [{ key: "act", header: <span className="sr-only">Action</span>, align: "right" as const, cell: (n: NCR) => (
      n.status === "open" ? <Button size="sm" variant="outline" onClick={() => setClosing(n)}>Close</Button> : null
    ) }] : []),
  ];
  return (
    <Section
      actions={
        <Select value={status} onValueChange={(v) => url.set({ ncr: v === "open" ? null : v })}>
          <SelectTrigger className="w-full sm:w-36" aria-label="NCR status"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="open">Open</SelectItem><SelectItem value="closed">Closed</SelectItem><SelectItem value="all">All</SelectItem></SelectContent>
        </Select>
      }
    >
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch} caption="Non-conformance reports"
        empty={<EmptyState icon={BadgeCheck} title={status === "open" ? "No open non-conformances" : "No NCRs match"} description="Rejecting material in an inspection opens an NCR here." />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      <CloseNcr ncr={closing} onDone={() => setClosing(null)} />
    </Section>
  );
}

/* ---------------------------------------------------------------- Plans */

type ParamDraft = { name: string; kind: "numeric" | "pass_fail"; min: string; max: string; unit: string };

function PlanSheet({ plan, open, onOpenChange }: { plan: Plan | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [item, setItem] = useState<ItemOption | null>(null);
  const [d, setD] = useState({ stage: "receipt", sample_size: "1", is_active: true });
  const [params, setParams] = useState<ParamDraft[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const parameters = params.map((p) => (p.kind === "numeric"
    ? { name: p.name.trim(), kind: p.kind, min: p.min || null, max: p.max || null, unit: p.unit.trim() }
    : { name: p.name.trim(), kind: p.kind }));
  const save = useMutation({
    mutationFn: () => plan
      ? unwrap(api.PATCH("/api/v1/quality/plans/{id}/", { params: { path: { id: plan.id } }, body: { parameters, sample_size: Number(d.sample_size), is_active: d.is_active, version: plan.version } as never }))
      : unwrap(api.POST("/api/v1/quality/plans/", { body: { item: item!.id, stage: d.stage as never, parameters, sample_size: Number(d.sample_size) } })),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["quality", "plans"] }); toast("Inspection plan saved"); onOpenChange(false); },
    onError: (error) => { if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["quality", "plans"] }); },
  });
  useSeedOnOpen(open, plan, () => {
    setItem(null);
    setD(plan ? { stage: plan.stage, sample_size: String(plan.sample_size ?? 1), is_active: plan.is_active ?? true } : { stage: "receipt", sample_size: "1", is_active: true });
    setParams(((plan?.parameters as PlanParameter[] | undefined) ?? []).map((p) => ({ name: p.name, kind: p.kind, min: p.min ?? "", max: p.max ?? "", unit: p.unit ?? "" })));
    setLocalError(null);
  }, save.reset);
  const update = (i: number, patch: Partial<ParamDraft>) => setParams(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{plan ? "Edit inspection plan" : "New inspection plan"}</SheetTitle>
          <SheetDescription>What inspectors measure for an item at one stage. Applies to inspections created after it&apos;s saved.</SheetDescription>
        </SheetHeader>
        <form className="grid gap-5 px-4 pb-6" onSubmit={(ev) => {
          ev.preventDefault();
          const bad = !plan && !item ? "Choose the item." : params.some((p) => !p.name.trim()) ? "Every parameter needs a name."
            : params.some((p) => p.kind === "numeric" && ((p.min && !isDecimal(p.min)) || (p.max && !isDecimal(p.max)))) ? "Limits must be numbers."
              : !/^\d+$/.test(d.sample_size) || d.sample_size === "0" ? "Sample size must be a whole number above zero." : null;
          setLocalError(bad);
          if (!bad) save.mutate();
        }}>
          <div className="grid gap-4 sm:grid-cols-2">
            {plan ? (
              <Field id="pl-item" label="Item"><p className="num py-1.5"><ItemCode id={plan.item} /></p></Field>
            ) : (
              <Field id="pl-item" label="Item" error={fieldErrors(save.error).item}><ItemPicker id="pl-item" value={item} onChange={setItem} /></Field>
            )}
            <Field id="pl-stage" label="Stage" error={fieldErrors(save.error).stage}>
              <Select value={d.stage} onValueChange={(v) => setD({ ...d, stage: v })} disabled={!!plan}>
                <SelectTrigger id="pl-stage" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(STAGES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field id="pl-sample" label="Sample size" error={fieldErrors(save.error).sample_size}>
              <Input id="pl-sample" inputMode="numeric" className="num" value={d.sample_size} onChange={(ev) => setD({ ...d, sample_size: ev.target.value.replace(/\D/g, "") })} />
            </Field>
            {plan && (
              <div className="flex items-center gap-2 self-end pb-2">
                <Checkbox id="pl-active" checked={d.is_active} onCheckedChange={(v) => setD({ ...d, is_active: v === true })} />
                <Label htmlFor="pl-active" className="font-normal">Active</Label>
              </div>
            )}
          </div>
          <div className="grid gap-3">
            <p className="type-section">Parameters</p>
            {params.length === 0 && <p className="text-sm text-muted-foreground">No parameters: inspectors record only accepted and rejected quantities.</p>}
            <ol className="grid gap-3">
              {params.map((p, i) => (
                <li key={i} className="grid gap-3 rounded-md border p-3">
                  <div className="grid grid-cols-[minmax(0,1fr)_9rem_auto] items-end gap-2">
                    <Field id={`pp-name-${i}`} label="Name"><Input id={`pp-name-${i}`} value={p.name} onChange={(ev) => update(i, { name: ev.target.value })} placeholder="Diameter" /></Field>
                    <Field id={`pp-kind-${i}`} label="Kind">
                      <Select value={p.kind} onValueChange={(v) => update(i, { kind: v as ParamDraft["kind"] })}>
                        <SelectTrigger id={`pp-kind-${i}`} className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="numeric">Measured</SelectItem><SelectItem value="pass_fail">Pass / fail</SelectItem></SelectContent>
                      </Select>
                    </Field>
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove parameter ${i + 1}`} onClick={() => setParams(params.filter((_, j) => j !== i))}><Trash2 /></Button>
                  </div>
                  {p.kind === "numeric" && (
                    <div className="grid grid-cols-3 gap-2">
                      <Field id={`pp-min-${i}`} label="Min"><Input id={`pp-min-${i}`} inputMode="decimal" className="num" value={p.min} onChange={(ev) => update(i, { min: ev.target.value })} /></Field>
                      <Field id={`pp-max-${i}`} label="Max"><Input id={`pp-max-${i}`} inputMode="decimal" className="num" value={p.max} onChange={(ev) => update(i, { max: ev.target.value })} /></Field>
                      <Field id={`pp-unit-${i}`} label="Unit"><Input id={`pp-unit-${i}`} value={p.unit} onChange={(ev) => update(i, { unit: ev.target.value })} placeholder="mm" /></Field>
                    </div>
                  )}
                </li>
              ))}
            </ol>
            <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setParams([...params, { name: "", kind: "numeric", min: "", max: "", unit: "" }])}><Plus aria-hidden /> Add parameter</Button>
          </div>
          {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
          <ActionError error={bannerError(save.error)} denied="You can't manage inspection plans." />
          <Button type="submit" disabled={save.isPending}>Save plan</Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function Plans() {
  const url = useUrlState();
  const { can } = useSession();
  const [editing, setEditing] = useState<Plan | null>(null);
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["quality", "plans", url.page],
    queryFn: () => unwrap(api.GET("/api/v1/quality/plans/", { params: { query: { page: url.page } } })),
  });
  const columns: Column<Plan>[] = [
    { key: "item", header: "Item", cell: (p) => <ItemCode id={p.item} /> },
    { key: "stage", header: "Stage", cell: (p) => STAGES[p.stage] ?? p.stage },
    { key: "params", header: "Parameters", cell: (p) => {
      const list = (p.parameters as PlanParameter[] | undefined) ?? [];
      return <span className="block max-w-[36ch] truncate text-muted-foreground">{list.length ? list.map((x) => x.name).join(", ") : "None"}</span>;
    } },
    { key: "sample", header: "Sample", align: "right", cell: (p) => <span className="num">{p.sample_size ?? 1}</span> },
    { key: "status", header: "Status", cell: (p) => <ActiveStatus active={p.is_active ?? true} /> },
    ...(can("quality.inspection_plan.update") ? [{ key: "edit", header: <span className="sr-only">Edit</span>, align: "right" as const, cell: (p: Plan) => (
      <Button variant="ghost" size="icon-sm" aria-label="Edit plan" onClick={() => { setEditing(p); setOpen(true); }}><Pencil /></Button>
    ) }] : []),
  ];
  return (
    <Section actions={can("quality.inspection_plan.create") && <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus aria-hidden /> New plan</Button>}>
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch} caption="Inspection plans"
        empty={<EmptyState icon={ClipboardCheck} title="No inspection plans" description="Without a plan, inspectors record quantities only." />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      <PlanSheet plan={editing} open={open} onOpenChange={setOpen} />
    </Section>
  );
}

export function QualityView() {
  const url = useUrlState();
  const { can } = useSession();
  const tabs = [
    can("quality.inspection.read") && (["inspections", "Inspections"] as const),
    can("quality.ncr.read") && (["ncrs", "Non-conformances"] as const),
    can("quality.inspection_plan.read") && (["plans", "Inspection plans"] as const),
  ].filter(Boolean) as ReadonlyArray<readonly [string, string]>;
  const tab = url.get("tab") || tabs[0]?.[0] || "inspections";
  const inspection = url.get("inspection");
  return (
    <>
      <PageHeader title="Quality" description="Material on quality hold waits here for a decision. Accepted stock becomes available; rejected stock is blocked." />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === tabs[0]?.[0] ? null : v })}>
        <TabsList className={cn("mb-4 max-w-full overflow-x-auto")}>
          {tabs.map(([k, label]) => <TabsTrigger key={k} value={k}>{label}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="inspections"><Inspections /></TabsContent>
        <TabsContent value="ncrs"><Ncrs /></TabsContent>
        <TabsContent value="plans"><Plans /></TabsContent>
      </Tabs>
      <DecideSheet inspectionId={inspection || null} onClose={() => url.set({ inspection: null })} />
    </>
  );
}
