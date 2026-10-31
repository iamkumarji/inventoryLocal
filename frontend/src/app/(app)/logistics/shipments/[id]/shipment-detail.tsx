"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ClipboardSignature, Send, Upload } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, DocStatus, ExpiryDate, Facts, humanize, Money, Notice } from "@/components/trade/common";
import { Actions, useTradeAction } from "@/components/trade/layout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, usePartnerIndex } from "@/lib/api/trade";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

import { expiredDocs, useDrivers, useVehicles } from "../shipments-view";

type Shipment = components["schemas"]["Shipment"];
type Delivery = components["schemas"]["SalesDelivery"];
type Outcome = components["schemas"]["PodOutcomeEnum"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nowLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function ProofDialog({ shipment, delivery, onClose }: { shipment: Shipment; delivery: Delivery; onClose: () => void }) {
  const { can, flag } = useSession();
  const fileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ outcome: "delivered" as Outcome, received_by_name: "", received_at: nowLocal(), signature_document_id: "", photo_document_id: "", remarks: "" });
  const needsProof = form.outcome !== "refused";
  const idsValid = [form.signature_document_id, form.photo_document_id].every((v) => !v || UUID_RE.test(v.trim()));
  const hasProof = !!(form.signature_document_id.trim() || form.photo_document_id.trim());
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", `Signature ${delivery.number}`);
      fd.append("category", "proof_of_delivery");
      fd.append("resource_type", "logistics.shipment");
      fd.append("resource_id", shipment.id);
      return unwrap(api.POST("/api/v1/documents/documents/", { body: fd as unknown as components["schemas"]["DocumentCreateRequest"] }));
    },
    onSuccess: (doc) => { setForm((f) => ({ ...f, signature_document_id: doc.id })); toast("Signature uploaded"); },
  });
  const save = useTradeAction(() =>
    unwrap(api.POST("/api/v1/logistics/shipments/{id}/proof/", {
      params: { path: { id: shipment.id } },
      body: {
        delivery: delivery.id, outcome: form.outcome, received_by_name: form.received_by_name, received_at: new Date(form.received_at).toISOString(),
        signature_document_id: form.signature_document_id.trim() || null, photo_document_id: form.photo_document_id.trim() || null, remarks: form.remarks,
      },
    })),
  (s) => { toast(s.status === "delivered" ? "All deliveries confirmed: shipment delivered" : "Proof of delivery recorded"); onClose(); });
  const canUpload = can("documents.document.create") && flag("module.documents");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
          <DialogHeader>
            <DialogTitle>Proof of delivery · {delivery.number}</DialogTitle>
            <DialogDescription>A delivered or partial outcome needs the receiver&apos;s signature (or a photo) as a stored document. One proof per delivery.</DialogDescription>
          </DialogHeader>
          <ActionError error={save.error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="pod-outcome" label="Outcome">
              <Select value={form.outcome} onValueChange={(v) => setForm({ ...form, outcome: v as Outcome })}>
                <SelectTrigger id="pod-outcome" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="delivered">Delivered</SelectItem><SelectItem value="partial">Partly delivered</SelectItem><SelectItem value="refused">Refused</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field id="pod-at" label="Received at"><Input id="pod-at" type="datetime-local" value={form.received_at} onChange={(e) => setForm({ ...form, received_at: e.target.value })} required /></Field>
            <Field id="pod-by" label="Received by" className="sm:col-span-2"><Input id="pod-by" maxLength={150} value={form.received_by_name} onChange={(e) => setForm({ ...form, received_by_name: e.target.value })} required /></Field>
            <Field id="pod-sig" label="Signature document ID" className="sm:col-span-2"
              error={form.signature_document_id && !UUID_RE.test(form.signature_document_id.trim()) ? "A document ID looks like 01a191e5-…" : undefined}
              hint={needsProof ? "Required (or a photo) unless the delivery was refused." : "Optional for a refusal."}>
              <div className="flex gap-2">
                <Input id="pod-sig" className="num" value={form.signature_document_id} onChange={(e) => setForm({ ...form, signature_document_id: e.target.value })} />
                {canUpload && (
                  <>
                    <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden" aria-label="Signature file"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ""; }} />
                    <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={upload.isPending}><Upload aria-hidden /> Upload</Button>
                  </>
                )}
              </div>
            </Field>
            {upload.error && <ActionError error={upload.error} className="sm:col-span-2" />}
            <Field id="pod-photo" label="Photo document ID" className="sm:col-span-2"><Input id="pod-photo" className="num" value={form.photo_document_id} onChange={(e) => setForm({ ...form, photo_document_id: e.target.value })} /></Field>
            <Field id="pod-remarks" label="Remarks" className="sm:col-span-2"><Textarea id="pod-remarks" rows={2} maxLength={500} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} /></Field>
          </div>
          <DialogFooter><Button type="submit" disabled={!form.received_by_name.trim() || !idsValid || (needsProof && !hasProof) || save.isPending}>Record proof</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ShipmentDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const scopes = useCompanyScopes();
  const customers = usePartnerIndex("customer");
  const vehicles = useVehicles();
  const drivers = useDrivers();
  const [proving, setProving] = useState<Delivery | null>(null);
  const query = useQuery({ queryKey: tradeKey("shipments", id), queryFn: () => unwrap(api.GET("/api/v1/logistics/shipments/{id}/", { params: { path: { id } } })) });
  const deliveries = useQuery({
    queryKey: tradeKey("deliveries", "posted"),
    queryFn: () => unwrap(api.GET("/api/v1/sales/deliveries/", { params: { query: { status: "posted", page_size: 100 } } })),
  });
  const dispatch = useTradeAction(() => unwrap(api.POST("/api/v1/logistics/shipments/{id}/dispatch/", { params: { path: { id } } })),
    () => toast("Shipment dispatched"));
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const s = query.data!;
  const vehicle = vehicles.data?.results.find((v) => v.id === s.vehicle);
  const driver = drivers.data?.results.find((d) => d.id === s.driver);
  const expired = expiredDocs(vehicle, driver);
  const rows = (s.deliveries ?? []).map((did) => deliveries.data?.results.find((d) => d.id === did) ?? ({ id: did, number: "…" } as Delivery));
  const proofFor = (did: string) => s.proofs.find((p) => p.delivery === did);
  const canProve = (s.status === "dispatched" || s.status === "partially_delivered") && can("logistics.shipment.deliver");
  const columns: Column<Delivery>[] = [
    { key: "number", header: "Delivery", cell: (d) => <Link className="num underline underline-offset-2" href={`/sales/deliveries/${d.id}`}>{d.number || "—"}</Link> },
    { key: "customer", header: "Customer", cell: (d) => customers.name(d.customer) },
    { key: "date", header: "Date", cell: (d) => date(d.delivery_date) },
    { key: "pod", header: "Proof of delivery", cell: (d) => {
      const p = proofFor(d.id);
      if (!p) return <span className="text-muted-foreground">Not yet</span>;
      return <span className="grid gap-0.5"><DocStatus status={p.outcome} /><span className="text-xs text-muted-foreground">{p.received_by_name}, {dateTime(p.received_at)}{p.signature_document_id ? " · signed" : ""}</span></span>;
    } },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (d) => canProve && !proofFor(d.id)
      ? <Button size="sm" variant="outline" onClick={() => setProving(d)}><ClipboardSignature aria-hidden /> Record proof</Button> : null },
  ];
  return (
    <>
      <PageHeader crumbs={[{ label: "Shipments", href: "/logistics/shipments" }, { label: s.number }]} title={`Shipment ${s.number}`}
        meta={<><DocStatus status={s.status} /><span className="text-muted-foreground">Planned {date(s.planned_date)}</span><span className="num">{vehicle?.registration ?? s.carrier_name}</span></>}
        actions={<Actions>{s.status === "planned" && can("logistics.shipment.dispatch") && (
          <Button onClick={() => dispatch.mutate(undefined)} disabled={dispatch.isPending}><Send aria-hidden /> Dispatch</Button>
        )}</Actions>} />
      <ActionError error={dispatch.error} className="mb-4" />
      <div className="grid grid-cols-1 gap-6">
        {s.status === "planned" && expired.length > 0 && !dispatch.error && (
          <Notice tone="rejected">Dispatch will be refused until these are renewed: {expired.join("; ")}.</Notice>
        )}
        <Section title="Deliveries" description="Record proof for each delivery after dispatch. The shipment is delivered when every delivery has proof.">
          <DataTable columns={columns} rows={rows} caption="Deliveries on this shipment" />
        </Section>
        <Section title="Trip">
          <Facts items={[
            ["Vehicle", vehicle ? <span key="v" className="num">{vehicle.registration} · {vehicle.vehicle_type}</span> : "—"],
            ["Driver", driver ? `${driver.name} · ${driver.phone}` : "—"],
            ...(vehicle ? ([["Insurance", <ExpiryDate key="i" value={vehicle.insurance_expires_on} />], ["Permit", <ExpiryDate key="p" value={vehicle.permit_expires_on} />],
              ["Fitness", <ExpiryDate key="f" value={vehicle.fitness_expires_on} />], ["PUC", <ExpiryDate key="u" value={vehicle.puc_expires_on} />]] as [string, React.ReactNode][]) : []),
            ...(driver ? ([["Licence", <ExpiryDate key="l" value={driver.licence_expires_on} />]] as [string, React.ReactNode][]) : []),
            ["Transporter", s.carrier_name || "—"],
            ["LR number", s.lr_number || "—"],
            ["Direction", humanize(s.direction ?? "outbound")],
            ["Branch", scopes.name(s.branch)],
            ["Freight", <Money key="fr" value={s.freight_cost} />],
            ["Dispatched", s.dispatched_at ? dateTime(s.dispatched_at) : "—"],
            ["Completed", s.completed_at ? dateTime(s.completed_at) : "—"],
          ]} />
        </Section>
      </div>
      {proving && <ProofDialog shipment={s} delivery={proving} onClose={() => setProving(null)} />}
    </>
  );
}
