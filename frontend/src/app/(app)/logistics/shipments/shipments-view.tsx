"use client";

import { useQuery } from "@tanstack/react-query";
import { CarFront, Pencil, Plus, Truck, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { ActionError, daysUntil, DocStatus, ExpiryDate, humanize, today } from "@/components/trade/common";
import { trim } from "@/components/trade/decimal";
import { FormSheet, StatusFilter, useTradeAction } from "@/components/trade/layout";
import { BranchSelect } from "@/components/trade/pickers";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, usePartnerIndex } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type Shipment = components["schemas"]["Shipment"];
type Vehicle = components["schemas"]["Vehicle"];
type Driver = components["schemas"]["Driver"];
type Expiring = { kind: "vehicle" | "driver"; id: string; name: string; document: string; expires_on: string };

const NONE = "__none__";
const VEHICLE_DOCS = [["insurance_expires_on", "Insurance"], ["permit_expires_on", "Permit"], ["fitness_expires_on", "Fitness"], ["puc_expires_on", "PUC"]] as const;

export function useVehicles() {
  return useQuery({ queryKey: tradeKey("vehicles"), queryFn: () => unwrap(api.GET("/api/v1/logistics/vehicles/", { params: { query: { page_size: 200 } } })) });
}
export function useDrivers() {
  return useQuery({ queryKey: tradeKey("drivers"), queryFn: () => unwrap(api.GET("/api/v1/logistics/drivers/", { params: { query: { page_size: 200 } } })) });
}

/** Expired documents for a vehicle or driver, as of today (the dispatch check runs on the server). */
export function expiredDocs(vehicle?: Vehicle, driver?: Driver): string[] {
  const out: string[] = [];
  if (vehicle) for (const [key, label] of VEHICLE_DOCS) if ((daysUntil(vehicle[key]) ?? 1) < 0) out.push(`${vehicle.registration}: ${label.toLowerCase()} expired`);
  if (driver && (daysUntil(driver.licence_expires_on) ?? 1) < 0) out.push(`${driver.name}: licence expired`);
  return out;
}

function PlanShipment({ initialDelivery, onClose }: { initialDelivery: string; onClose: () => void }) {
  const router = useRouter();
  const scopes = useCompanyScopes();
  const customers = usePartnerIndex("customer");
  const vehicles = useVehicles();
  const drivers = useDrivers();
  const [form, setForm] = useState({ branch: "", planned_date: today(), direction: "outbound" as "outbound" | "inbound", vehicle: NONE, driver: NONE, carrier_name: "", lr_number: "", freight_cost: "" });
  const [deliveries, setDeliveries] = useState<string[]>(initialDelivery ? [initialDelivery] : []);
  const posted = useQuery({
    queryKey: tradeKey("deliveries", "posted"),
    queryFn: () => unwrap(api.GET("/api/v1/sales/deliveries/", { params: { query: { status: "posted", page_size: 100 } } })),
  });
  const vehicle = vehicles.data?.results.find((v) => v.id === form.vehicle);
  const driver = drivers.data?.results.find((d) => d.id === form.driver);
  const warnings = expiredDocs(vehicle, driver);
  const create = useTradeAction(() =>
    unwrap(api.POST("/api/v1/logistics/shipments/", {
      body: {
        company: scopes.companyId, branch: form.branch, direction: form.direction, planned_date: form.planned_date,
        vehicle: form.vehicle === NONE ? null : form.vehicle, driver: form.driver === NONE ? null : form.driver,
        carrier_name: form.carrier_name, lr_number: form.lr_number, freight_cost: form.freight_cost || "0", deliveries,
      },
    })),
  (s) => { toast(`Shipment ${s.number} planned`); onClose(); router.push(`/logistics/shipments/${s.id}`); });
  return (
    <FormSheet open onOpenChange={(o) => !o && onClose()} title="Plan shipment" description="Group posted deliveries on a vehicle with a driver, or hand them to a transporter. Expired vehicle or driver documents block dispatch.">
      <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
        <ActionError error={create.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="sh-branch" label="Branch"><BranchSelect id="sh-branch" value={form.branch} onChange={(v) => setForm({ ...form, branch: v })} /></Field>
          <Field id="sh-date" label="Planned date"><Input id="sh-date" type="date" value={form.planned_date} onChange={(e) => setForm({ ...form, planned_date: e.target.value })} required /></Field>
          <Field id="sh-vehicle" label="Vehicle">
            <Select value={form.vehicle} onValueChange={(v) => setForm({ ...form, vehicle: v })}>
              <SelectTrigger id="sh-vehicle" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>No own vehicle (transporter)</SelectItem>
                {vehicles.data?.results.filter((v) => v.is_active !== false).map((v) => <SelectItem key={v.id} value={v.id}>{v.registration} · {v.vehicle_type}{expiredDocs(v).length ? " · documents expired" : ""}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="sh-driver" label="Driver">
            <Select value={form.driver} onValueChange={(v) => setForm({ ...form, driver: v })}>
              <SelectTrigger id="sh-driver" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>No driver</SelectItem>
                {drivers.data?.results.filter((d) => d.is_active !== false).map((d) => <SelectItem key={d.id} value={d.id}>{d.name}{expiredDocs(undefined, d).length ? " · licence expired" : ""}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="sh-carrier" label="Transporter" hint="Needed when no own vehicle is used."><Input id="sh-carrier" maxLength={150} value={form.carrier_name} onChange={(e) => setForm({ ...form, carrier_name: e.target.value })} /></Field>
          <Field id="sh-lr" label="LR number"><Input id="sh-lr" maxLength={40} value={form.lr_number} onChange={(e) => setForm({ ...form, lr_number: e.target.value })} /></Field>
          <Field id="sh-freight" label="Freight cost (₹)"><Input id="sh-freight" inputMode="decimal" className="num" value={form.freight_cost} onChange={(e) => setForm({ ...form, freight_cost: e.target.value })} /></Field>
        </div>
        {warnings.length > 0 && (
          <p role="status" className="rounded-md border border-status-pending/30 bg-status-pending/10 px-3 py-2 text-sm text-status-pending">
            You can plan this shipment, but it can&apos;t be dispatched until these are renewed: {warnings.join("; ")}.
          </p>
        )}
        <fieldset className="grid min-w-0 gap-2">
          <legend className="type-section mb-1">Deliveries</legend>
          {posted.data?.results.length === 0 && <p className="text-sm text-muted-foreground">No posted deliveries.</p>}
          <ul className="grid gap-1.5">
            {posted.data?.results.map((d) => (
              <li key={d.id}>
                <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <Checkbox checked={deliveries.includes(d.id)} onCheckedChange={(v) => setDeliveries(v === true ? [...deliveries, d.id] : deliveries.filter((x) => x !== d.id))} />
                  <span className="num font-medium">{d.number}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{customers.name(d.customer)} · {date(d.delivery_date)} · {scopes.name(d.warehouse)}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <Button type="submit" disabled={!form.branch || (form.vehicle === NONE && !form.carrier_name.trim()) || create.isPending}>Plan shipment</Button>
      </form>
    </FormSheet>
  );
}

function VehicleDialog({ vehicle, onClose }: { vehicle: Vehicle | null; onClose: () => void }) {
  const scopes = useCompanyScopes();
  const [form, setForm] = useState(() => ({
    branch: vehicle?.branch ?? "", registration: vehicle?.registration ?? "", vehicle_type: vehicle?.vehicle_type ?? "", capacity_kg: vehicle?.capacity_kg ? trim(vehicle.capacity_kg) : "",
    ownership: (vehicle?.ownership ?? "owned") as "owned" | "hired", insurance_expires_on: vehicle?.insurance_expires_on ?? "", permit_expires_on: vehicle?.permit_expires_on ?? "",
    fitness_expires_on: vehicle?.fitness_expires_on ?? "", puc_expires_on: vehicle?.puc_expires_on ?? "", is_active: vehicle ? vehicle.is_active !== false : true,
  }));
  const docs = { insurance_expires_on: form.insurance_expires_on || null, permit_expires_on: form.permit_expires_on || null, fitness_expires_on: form.fitness_expires_on || null, puc_expires_on: form.puc_expires_on || null };
  const save = useTradeAction(() => {
    const common = { vehicle_type: form.vehicle_type, capacity_kg: form.capacity_kg || "0", ownership: form.ownership, is_active: form.is_active, ...docs };
    if (vehicle) {
      const body = { ...common, version: vehicle.version };
      return unwrap(api.PATCH("/api/v1/logistics/vehicles/{id}/", { params: { path: { id: vehicle.id } }, body }));
    }
    return unwrap(api.POST("/api/v1/logistics/vehicles/", { body: { ...common, company: scopes.companyId, branch: form.branch, registration: form.registration } }));
  }, () => { toast(vehicle ? "Vehicle updated" : "Vehicle added"); onClose(); });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
          <DialogHeader><DialogTitle>{vehicle ? `Edit ${vehicle.registration}` : "Add vehicle"}</DialogTitle><DialogDescription>Shipments can&apos;t be dispatched on a vehicle with any expired document.</DialogDescription></DialogHeader>
          <ActionError error={save.error} />
          <div className="grid gap-4 sm:grid-cols-2">
            {!vehicle && <Field id="v-branch" label="Branch"><BranchSelect id="v-branch" value={form.branch} onChange={(v) => setForm({ ...form, branch: v })} /></Field>}
            {!vehicle && <Field id="v-reg" label="Registration"><Input id="v-reg" className="num uppercase" maxLength={15} value={form.registration} onChange={(e) => setForm({ ...form, registration: e.target.value.toUpperCase().replace(/\s/g, "") })} required /></Field>}
            <Field id="v-type" label="Type"><Input id="v-type" maxLength={40} value={form.vehicle_type} onChange={(e) => setForm({ ...form, vehicle_type: e.target.value })} required placeholder="Tempo, 10-tonne truck…" /></Field>
            <Field id="v-cap" label="Capacity (kg)"><Input id="v-cap" inputMode="decimal" className="num" value={form.capacity_kg} onChange={(e) => setForm({ ...form, capacity_kg: e.target.value })} /></Field>
            <Field id="v-own" label="Ownership">
              <Select value={form.ownership} onValueChange={(v) => setForm({ ...form, ownership: v as "owned" | "hired" })}>
                <SelectTrigger id="v-own" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="owned">Owned</SelectItem><SelectItem value="hired">Hired</SelectItem></SelectContent>
              </Select>
            </Field>
            {VEHICLE_DOCS.map(([key, label]) => (
              <Field key={key} id={`v-${key}`} label={`${label} expires`}><Input id={`v-${key}`} type="date" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></Field>
            ))}
            <div className="flex items-center justify-between rounded-md border px-3 py-2 sm:col-span-2">
              <Label htmlFor="v-active" className="font-normal">In service</Label>
              <Switch id="v-active" checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
            </div>
          </div>
          <DialogFooter><Button type="submit" disabled={save.isPending || (!vehicle && (!form.branch || !form.registration))}>Save vehicle</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DriverDialog({ driver, onClose }: { driver: Driver | null; onClose: () => void }) {
  const scopes = useCompanyScopes();
  const [form, setForm] = useState(() => ({
    branch: driver?.branch ?? "", name: driver?.name ?? "", phone: driver?.phone ?? "", licence_number: driver?.licence_number ?? "",
    licence_expires_on: driver?.licence_expires_on ?? "", is_active: driver ? driver.is_active !== false : true,
  }));
  const save = useTradeAction(() => {
    if (driver) {
      const body = { phone: form.phone, licence_expires_on: form.licence_expires_on, is_active: form.is_active, version: driver.version };
      return unwrap(api.PATCH("/api/v1/logistics/drivers/{id}/", { params: { path: { id: driver.id } }, body }));
    }
    return unwrap(api.POST("/api/v1/logistics/drivers/", { body: { company: scopes.companyId, branch: form.branch, name: form.name, phone: form.phone, licence_number: form.licence_number, licence_expires_on: form.licence_expires_on, is_active: form.is_active } }));
  }, () => { toast(driver ? "Driver updated" : "Driver added"); onClose(); });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
          <DialogHeader><DialogTitle>{driver ? `Edit ${driver.name}` : "Add driver"}</DialogTitle><DialogDescription>A driver with an expired licence can&apos;t take a shipment out.</DialogDescription></DialogHeader>
          <ActionError error={save.error} />
          {!driver && <Field id="d-branch" label="Branch"><BranchSelect id="d-branch" value={form.branch} onChange={(v) => setForm({ ...form, branch: v })} /></Field>}
          {!driver && <Field id="d-name" label="Name"><Input id="d-name" maxLength={150} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>}
          <Field id="d-phone" label="Phone"><Input id="d-phone" maxLength={20} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required /></Field>
          {!driver && <Field id="d-licence" label="Licence number"><Input id="d-licence" className="num uppercase" maxLength={30} value={form.licence_number} onChange={(e) => setForm({ ...form, licence_number: e.target.value.toUpperCase() })} required /></Field>}
          <Field id="d-expiry" label="Licence expires"><Input id="d-expiry" type="date" value={form.licence_expires_on} onChange={(e) => setForm({ ...form, licence_expires_on: e.target.value })} required /></Field>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label htmlFor="d-active" className="font-normal">Active</Label>
            <Switch id="d-active" checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
          </div>
          <DialogFooter><Button type="submit" disabled={save.isPending || (!driver && !form.branch)}>Save driver</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ExpiringPanel() {
  const query = useQuery({
    queryKey: tradeKey("vehicles", "expiring"),
    queryFn: async () => (await unwrap(api.GET("/api/v1/logistics/vehicles/expiring/", { params: { query: { within_days: 30 } } }))) as unknown as Expiring[],
  });
  if (!query.data || query.data.length === 0) return null;
  return (
    <Section title="Documents expiring within 30 days" className="mb-4">
      <ul className="grid gap-1.5 px-5 py-3 text-sm">
        {query.data.map((e) => (
          <li key={`${e.id}-${e.document}`} className="flex flex-wrap items-center justify-between gap-2">
            <span>{e.kind === "vehicle" ? <CarFront className="mr-1.5 inline size-4" aria-hidden /> : <UserRound className="mr-1.5 inline size-4" aria-hidden />}{e.name} · {humanize(e.document)}</span>
            <ExpiryDate value={e.expires_on} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function ShipmentsView() {
  const { can } = useSession();
  const url = useUrlState();
  const tab = url.get("tab") || "shipments";
  const status = url.get("status");
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null | undefined>(undefined);
  const [editingDriver, setEditingDriver] = useState<Driver | null | undefined>(undefined);
  const vehicles = useVehicles();
  const drivers = useDrivers();
  const shipments = useQuery({
    queryKey: tradeKey("shipments", status, url.page),
    queryFn: () => unwrap(api.GET("/api/v1/logistics/shipments/", { params: { query: { status: (status || undefined) as Shipment["status"] | undefined, page: url.page } } })),
    enabled: tab === "shipments",
  });
  const vehicleReg = (id: string | null | undefined) => vehicles.data?.results.find((v) => v.id === id)?.registration;
  const driverName = (id: string | null | undefined) => drivers.data?.results.find((d) => d.id === id)?.name;
  const shipmentColumns: Column<Shipment>[] = [
    { key: "number", header: "Shipment", cell: (s) => <span><span className="num block">{s.number}</span><span className="block text-xs font-normal text-muted-foreground">{s.direction === "inbound" ? "Inbound" : "Outbound"}</span></span> },
    { key: "date", header: "Planned", cell: (s) => date(s.planned_date) },
    { key: "vehicle", header: "Vehicle / transporter", cell: (s) => <span className="num">{vehicleReg(s.vehicle) ?? (s.carrier_name || "—")}</span> },
    { key: "driver", header: "Driver", cell: (s) => driverName(s.driver) ?? "—" },
    { key: "deliveries", header: "Deliveries", align: "right", cell: (s) => <span className="num">{s.proofs.length}/{s.deliveries?.length ?? 0} done</span> },
    { key: "status", header: "Status", cell: (s) => <DocStatus status={s.status} /> },
  ];
  const vehicleColumns: Column<Vehicle>[] = [
    { key: "reg", header: "Vehicle", cell: (v) => <span><span className="num block font-medium">{v.registration}</span><span className="block text-xs text-muted-foreground">{v.vehicle_type} · {v.ownership === "hired" ? "hired" : "owned"}{v.capacity_kg ? ` · ${trim(v.capacity_kg)} kg` : ""}</span></span> },
    ...VEHICLE_DOCS.map(([key, label]) => ({ key, header: label, cell: (v: Vehicle) => <ExpiryDate value={v[key]} /> })),
    { key: "active", header: "Status", cell: (v) => <ActiveStatus active={v.is_active !== false} activeLabel="In service" inactiveLabel="Out of service" /> },
    { key: "edit", header: <span className="sr-only">Edit</span>, align: "right", cell: (v) => can("logistics.vehicle.update") && <Button size="icon-sm" variant="ghost" aria-label={`Edit ${v.registration}`} onClick={() => setEditingVehicle(v)}><Pencil /></Button> },
  ];
  const driverColumns: Column<Driver>[] = [
    { key: "name", header: "Driver", cell: (d) => <span><span className="block font-medium">{d.name}</span><span className="num block text-xs text-muted-foreground">{d.phone}</span></span> },
    { key: "licence", header: "Licence", cell: (d) => <span className="num">{d.licence_number}</span> },
    { key: "expiry", header: "Licence expires", cell: (d) => <ExpiryDate value={d.licence_expires_on} /> },
    { key: "active", header: "Status", cell: (d) => <ActiveStatus active={d.is_active !== false} /> },
    { key: "edit", header: <span className="sr-only">Edit</span>, align: "right", cell: (d) => can("logistics.driver.update") && <Button size="icon-sm" variant="ghost" aria-label={`Edit ${d.name}`} onClick={() => setEditingDriver(d)}><Pencil /></Button> },
  ];
  const action = tab === "shipments"
    ? can("logistics.shipment.create") && <Button onClick={() => url.set({ new: 1 })}><Plus aria-hidden /> Plan shipment</Button>
    : tab === "vehicles"
      ? can("logistics.vehicle.create") && <Button onClick={() => setEditingVehicle(null)}><Plus aria-hidden /> Add vehicle</Button>
      : can("logistics.driver.create") && <Button onClick={() => setEditingDriver(null)}><Plus aria-hidden /> Add driver</Button>;
  return (
    <>
      <PageHeader title="Shipments" description="Plan trips with deliveries, a vehicle and a driver, dispatch them and record proof of delivery." actions={action} />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "shipments" ? null : v, status: null })} className="mb-4">
        <TabsList>
          <TabsTrigger value="shipments">Shipments</TabsTrigger>
          <TabsTrigger value="vehicles">Vehicles</TabsTrigger>
          <TabsTrigger value="drivers">Drivers</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab !== "shipments" && <ExpiringPanel />}
      {tab === "shipments" && (
        <Section actions={<StatusFilter value={status} onChange={(v) => url.set({ status: v })}
          options={[["", "Any status"], ["planned", "Planned"], ["dispatched", "Dispatched"], ["partially_delivered", "Partly delivered"], ["delivered", "Delivered"]]} />}>
          <DataTable columns={shipmentColumns} rows={shipments.data?.results} isLoading={shipments.isLoading} error={shipments.error} onRetry={shipments.refetch}
            rowHref={(s) => `/logistics/shipments/${s.id}`} caption="Shipments"
            empty={<EmptyState icon={Truck} title="No shipments" description="Plan one from posted deliveries." />} />
          {shipments.data && <PageNav page={url.page} count={shipments.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
        </Section>
      )}
      {tab === "vehicles" && (
        <Section>
          <DataTable columns={vehicleColumns} rows={vehicles.data?.results} isLoading={vehicles.isLoading} error={vehicles.error} onRetry={vehicles.refetch} caption="Vehicles"
            empty={<EmptyState icon={CarFront} title="No vehicles" />} />
        </Section>
      )}
      {tab === "drivers" && (
        <Section>
          <DataTable columns={driverColumns} rows={drivers.data?.results} isLoading={drivers.isLoading} error={drivers.error} onRetry={drivers.refetch} caption="Drivers"
            empty={<EmptyState icon={UserRound} title="No drivers" />} />
        </Section>
      )}
      {url.get("new") === "1" && <PlanShipment initialDelivery={url.get("delivery")} onClose={() => url.set({ new: null, delivery: null })} />}
      {editingVehicle !== undefined && <VehicleDialog vehicle={editingVehicle} onClose={() => setEditingVehicle(undefined)} />}
      {editingDriver !== undefined && <DriverDialog driver={editingDriver} onClose={() => setEditingDriver(undefined)} />}
    </>
  );
}
