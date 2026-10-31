"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Ban, Check, Gauge, Pencil, Send, Wrench, X } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { RecordPanel } from "@/components/collaboration/record-panel";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { ActionDialog, Facts, Figure } from "@/components/production/action-dialog";
import { StateBadge } from "@/components/production/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import {
  dec, isDecimal, localToIso, nowLocal, problemMessage, qty, today, useOrgPlaces, usePersonLabel, type Asset,
} from "@/lib/api/production";
import { date, dateTime, money } from "@/lib/format";
import { useSession } from "@/lib/session";

const METHOD_LABEL = { slm: "Straight line", wdv: "Written down value" } as const;

function EditDraft({ asset, onSaved }: { asset: Asset; onSaved: (a: Asset) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: asset.name, cost: dec.norm(asset.cost), put_to_use_date: asset.put_to_use_date ?? "", location: asset.location ?? "" });
  const save = useMutation({
    mutationFn: () => unwrap(api.PATCH("/api/v1/assets/assets/{id}/", {
      params: { path: { id: asset.id } },
      body: { version: asset.version, name: form.name, cost: form.cost, put_to_use_date: form.put_to_use_date || null, location: form.location },
    })),
    onSuccess: (a) => { onSaved(a); toast("Asset saved"); setOpen(false); },
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  return (
    <ActionDialog open={open} onOpenChange={(next) => { if (next) setForm({ name: asset.name, cost: dec.norm(asset.cost), put_to_use_date: asset.put_to_use_date ?? "", location: asset.location ?? "" }); setOpen(next); }}
      trigger={<Button variant="outline"><Pencil aria-hidden /> Edit</Button>} title={`Edit ${asset.code}`}
      submitLabel="Save" pending={save.isPending} error={save.error} disabled={!form.name || !isDecimal(form.cost, { maxDp: 4, allowZero: false })} onSubmit={() => save.mutate()}>
      <Field id="e-name" label="Name" error={errors.name}><Input id="e-name" className="h-10" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="e-cost" label="Cost (₹)" error={errors.cost}><Input id="e-cost" inputMode="decimal" className="num h-10" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
        <Field id="e-put" label="Put to use on" error={errors.put_to_use_date}><Input id="e-put" type="date" className="h-10" value={form.put_to_use_date} onChange={(e) => setForm({ ...form, put_to_use_date: e.target.value })} /></Field>
      </div>
      <Field id="e-location" label="Location" error={errors.location}><Input id="e-location" className="h-10" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></Field>
    </ActionDialog>
  );
}

function DisposeDialog({ asset, onDone }: { asset: Asset; onDone: (a: Asset) => void }) {
  const { withStepUp } = useStepUp();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"sale" | "scrap">("scrap");
  const [on, setOn] = useState(today());
  const [proceeds, setProceeds] = useState("0");
  const [reason, setReason] = useState("");
  const dispose = useMutation({
    mutationFn: () => {
      const key = idempotencyKey();
      return withStepUp(() => unwrap(api.POST("/api/v1/assets/assets/{id}/dispose/", {
        params: { path: { id: asset.id }, header: { "Idempotency-Key": key } },
        body: { on, disposal_kind: kind, proceeds: kind === "scrap" ? proceeds || "0" : proceeds, reason, version: asset.version },
      })));
    },
    onSuccess: (a) => {
      onDone(a);
      const gain = a.disposal_gain ?? "0";
      toast(dec.positive(gain) ? `Disposed with a gain of ${money(gain)}` : dec.cmp(gain, "0") < 0 ? `Disposed with a loss of ${money(dec.sub("0", gain))}` : "Disposed at book value");
      setOpen(false);
    },
  });
  const valid = isDecimal(proceeds || "0", { maxDp: 4 }) && (kind === "scrap" || dec.positive(proceeds));
  const gain = dec.sub(proceeds || "0", asset.book_value);
  return (
    <ActionDialog open={open} onOpenChange={setOpen} trigger={<Button variant="outline" className="border-status-rejected/40 text-status-rejected hover:bg-status-rejected/10"><Ban aria-hidden /> Dispose</Button>}
      title={`Dispose of ${asset.code}`} description="Posts the disposal journal: removes cost and accumulated depreciation; the difference to proceeds is a gain or loss. Post the disposal month's depreciation first if it should be charged."
      submitLabel="Dispose asset" destructive pending={dispose.isPending} error={dispose.error} disabled={!valid} onSubmit={() => dispose.mutate()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="d-kind" label="Disposal">
          <Select value={kind} onValueChange={(v) => setKind(v as "sale" | "scrap")}>
            <SelectTrigger id="d-kind" className="h-10 w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="sale">Sale</SelectItem><SelectItem value="scrap">Scrap</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field id="d-on" label="Disposal date"><Input id="d-on" type="date" className="h-10" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
        <Field id="d-proceeds" label="Proceeds (₹)" hint={kind === "sale" ? "Received into the default bank account." : "Scrap value, if any."}>
          <Input id="d-proceeds" inputMode="decimal" className="num h-10" value={proceeds} onChange={(e) => setProceeds(e.target.value)} />
        </Field>
        <div className="grid content-end gap-1 text-sm">
          <span className="text-muted-foreground">Book value {money(asset.book_value)}</span>
          <span className={dec.cmp(gain, "0") < 0 ? "text-status-rejected" : "text-status-approved"}>
            {dec.cmp(gain, "0") < 0 ? `Loss ${money(dec.sub("0", gain))}` : `Gain ${money(gain)}`}
          </span>
        </div>
      </div>
      <Field id="d-reason" label="Reason"><Input id="d-reason" className="h-10" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </ActionDialog>
  );
}

function Reliability({ asset }: { asset: Asset }) {
  const r = useQuery({
    queryKey: ["assets", "asset", asset.id, "reliability"],
    queryFn: () => unwrap(api.GET("/api/v1/assets/assets/{id}/reliability/", { params: { path: { id: asset.id } } })),
  });
  return (
    <Section title="Reliability" description={r.data ? `Breakdowns from ${date(r.data.window_start)} to ${date(r.data.window_end)}` : "From completed breakdown work orders."}>
      {r.error ? <ErrorState error={r.error} /> : r.data && (
        <div className="grid grid-cols-2 gap-3 p-5">
          <Figure label="MTBF" value={r.data.mtbf_hours === null ? "—" : `${qty(r.data.mtbf_hours)} h`} hint="Mean time between failures" />
          <Figure label="MTTR" value={r.data.mttr_hours === null ? "—" : `${qty(r.data.mttr_hours)} h`} hint="Mean time to repair" />
          <Figure label="Failures" value={r.data.failures} hint={`${qty(r.data.downtime_hours)} h down`} />
          <Figure label="Availability" value={r.data.availability_pct === null ? "—" : `${qty(r.data.availability_pct)}%`} />
        </div>
      )}
    </Section>
  );
}

function MeterReadings({ asset }: { asset: Asset }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [reading, setReading] = useState("");
  const [at, setAt] = useState(nowLocal());
  const readings = useQuery({
    queryKey: ["assets", "meter-readings", asset.id],
    queryFn: () => unwrap(api.GET("/api/v1/assets/meter-readings/", { params: { query: { asset: asset.id, page_size: 10 } } })),
  });
  const add = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/assets/meter-readings/", { body: { asset: asset.id, reading, reading_at: localToIso(at) ?? undefined } })),
    onSuccess: () => {
      setReading("");
      queryClient.invalidateQueries({ queryKey: ["assets", "meter-readings"] });
      queryClient.invalidateQueries({ queryKey: ["assets", "asset", asset.id] });
      toast("Meter reading recorded");
    },
  });
  return (
    <Section title="Meter" description={asset.current_meter_reading ? `Current reading ${qty(asset.current_meter_reading)}` : "No readings yet."}>
      {can("assets.meter_reading.create") && asset.status !== "disposed" && (
        <form className="grid gap-3 border-b px-5 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field id="m-reading" label="Reading"><Input id="m-reading" inputMode="decimal" className="num h-10" value={reading} onChange={(e) => setReading(e.target.value)} /></Field>
          <Field id="m-at" label="Taken at"><Input id="m-at" type="datetime-local" className="h-10" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
          <Button type="submit" className="h-10" disabled={!isDecimal(reading) || add.isPending}><Gauge aria-hidden /> Record</Button>
          <div className="sm:col-span-3"><FormError message={problemMessage(add.error)} /></div>
        </form>
      )}
      <ul className="divide-y">
        {(readings.data?.results ?? []).map((m) => (
          <li key={m.id} className="flex justify-between gap-3 px-5 py-2 text-sm">
            <span className="num font-medium">{qty(m.reading)}</span>
            <span className="text-muted-foreground">{dateTime(m.reading_at ?? m.created_at)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function AssetDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const { withStepUp } = useStepUp();
  const places = useOrgPlaces();
  const person = usePersonLabel();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const key = ["assets", "asset", id];
  const query = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/api/v1/assets/assets/{id}/", { params: { path: { id } } })) });
  const onDone = (a: Asset) => {
    queryClient.setQueryData(key, a);
    queryClient.invalidateQueries({ queryKey: ["assets", "register"] });
    queryClient.invalidateQueries({ queryKey: ["collaboration", "activity"] });
  };
  const onError = () => queryClient.invalidateQueries({ queryKey: key });

  const capitalize = useMutation({
    mutationFn: () => {
      const k = idempotencyKey();
      return withStepUp(() => unwrap(api.POST("/api/v1/assets/assets/{id}/capitalize/", {
        params: { path: { id }, header: { "Idempotency-Key": k } }, body: { version: query.data!.version },
      })));
    },
    onSuccess: (a) => { onDone(a); toast(`${a.code} capitalized; journal posted`); },
    onError,
  });
  const submit = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/assets/assets/{id}/submit/", { params: { path: { id } }, body: { version: query.data!.version } })),
    onSuccess: (a) => { onDone(a); toast("Submitted for capitalization approval"); },
    onError,
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) => {
      const k = idempotencyKey();
      return withStepUp(() => unwrap(api.POST("/api/v1/assets/assets/{id}/decide/", {
        params: { path: { id }, header: { "Idempotency-Key": k } }, body: { approve, comment, version: query.data!.version },
      })));
    },
    onSuccess: (a, approve) => { onDone(a); setComment(""); toast(approve ? `${a.code} approved and capitalized` : "Capitalization rejected"); },
    onError,
  });

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const a = query.data!;
  const draft = a.status === "draft" || a.status === "rejected";
  const madeByMe = a.created_by === me.user.id || a.submitted_by === me.user.id;
  const limitHit = isApiError(capitalize.error) && capitalize.error.problem.code === "approval_limit_exceeded";
  const actionError = capitalize.error ?? submit.error;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Fixed assets", href: "/assets" }, { label: a.code }]}
        title={a.name}
        meta={<>
          <StateBadge kind="asset" value={a.status} />
          <span className="num font-medium">{a.code}</span>
          <span className="num text-base font-semibold">{money(a.book_value)}</span>
          <span className="text-muted-foreground">book value</span>
        </>}
        actions={<>
          {draft && can("assets.asset.update") && <EditDraft asset={a} onSaved={onDone} />}
          {a.status === "capitalized" && can("assets.work_order.create") && (
            <Button variant="outline" asChild><Link href={`/assets/maintenance?asset=${a.id}&new=1`}><Wrench aria-hidden /> Report breakdown</Link></Button>
          )}
          {a.status === "capitalized" && can("assets.asset.dispose") && <DisposeDialog asset={a} onDone={onDone} />}
        </>}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          {draft && (can("assets.asset.approve") || can("assets.asset.update")) && (
            <Section title="Capitalize" description="Posts Dr fixed assets / Cr bank (or the contra account) on the put-to-use date. Within your approval limit you can capitalize directly; above it, submit for approval.">
              <div className="grid gap-3 px-5 py-4">
                {madeByMe && <p className="text-sm text-muted-foreground">You created this asset, so someone else must capitalize or approve it.</p>}
                <div className="flex flex-wrap gap-2">
                  {can("assets.asset.approve") && (
                    <Button size="lg" onClick={() => capitalize.mutate()} disabled={capitalize.isPending || madeByMe}><BadgeCheck aria-hidden /> Capitalize now</Button>
                  )}
                  {can("assets.asset.update") && (
                    <Button size="lg" variant={limitHit ? "default" : "outline"} onClick={() => submit.mutate()} disabled={submit.isPending}><Send aria-hidden /> Submit for approval</Button>
                  )}
                </div>
                <FormError message={problemMessage(actionError)} />
              </div>
            </Section>
          )}
          {a.status === "submitted" && (
            <Section title="Capitalization approval" description={`Submitted by ${person(a.submitted_by)}. Approving posts the capitalization journal.`}>
              {can("assets.asset.approve") && !madeByMe ? (
                <form className="grid gap-3 px-5 py-4" onSubmit={(e) => e.preventDefault()}>
                  <Field id="decide-comment" label="Comment" hint="Required when you reject.">
                    <Textarea id="decide-comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
                  </Field>
                  <FormError message={problemMessage(decide.error)} />
                  <div className="flex flex-wrap gap-2">
                    <Button size="lg" onClick={() => decide.mutate(true)} disabled={decide.isPending}><Check aria-hidden /> Approve and capitalize</Button>
                    <Button size="lg" variant="outline" className="border-status-rejected/40 text-status-rejected hover:bg-status-rejected/10"
                      onClick={() => decide.mutate(false)} disabled={decide.isPending || !comment.trim()}><X aria-hidden /> Reject</Button>
                  </div>
                </form>
              ) : <p className="px-5 py-4 text-sm text-muted-foreground">Waiting for an approver{madeByMe ? " other than you" : ""}.</p>}
            </Section>
          )}
          <Section title="Values">
            <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
              <Figure label="Cost" value={money(a.cost)} />
              <Figure label="Accumulated dep." value={money(a.accumulated_depreciation)} />
              <Figure label="Book value" value={money(a.book_value)} />
              <Figure label="Salvage" value={money(a.salvage_value)} />
            </div>
            {a.status === "disposed" && (
              <Facts className="border-t" items={[
                ["Disposal", `${a.disposal_kind === "sale" ? "Sale" : "Scrap"} on ${date(a.disposal_date)}`],
                ["Proceeds", money(a.disposal_proceeds)],
                ["Gain / loss", dec.cmp(a.disposal_gain ?? "0", "0") < 0
                  ? <span key="g" className="text-status-rejected">Loss {money(dec.sub("0", a.disposal_gain ?? "0"))}</span>
                  : <span key="g" className="text-status-approved">Gain {money(a.disposal_gain ?? "0")}</span>],
              ]} />
            )}
          </Section>
          <Section title="Details">
            <Facts items={[
              ["Category", <span key="c" className="num">{a.category_code}</span>],
              ["Depreciation", a.depreciation_method ? `${METHOD_LABEL[a.depreciation_method]}, ${a.depreciation_method === "slm" ? `${a.useful_life_months} months` : `${qty(a.wdv_rate)}% a year`}` : "—"],
              ["Facility", places.label(a.facility)],
              ["Location", a.location || "—"],
              ["Serial number", a.serial_number || "—"],
              ["Custodian", person(a.custodian, "Assigned")],
              ["Acquired", date(a.acquisition_date)],
              ["Put to use", date(a.put_to_use_date)],
              a.capitalized_at && ["Capitalized", dateTime(a.capitalized_at)],
            ]} />
          </Section>
          {(a.status === "capitalized" || a.status === "disposed") && <Reliability asset={a} />}
        </div>
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          {can("assets.meter_reading.read") && <MeterReadings asset={a} />}
          <RecordPanel resourceType="assets.asset" resourceId={a.id} />
        </div>
      </div>
    </>
  );
}

