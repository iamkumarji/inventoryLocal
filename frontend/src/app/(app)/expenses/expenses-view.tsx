"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fuel, HandCoins, Pencil, Plus, Search, Tags, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { TabStrip } from "@/components/people/actions";
import { Amount, DocStatus } from "@/components/people/amount";
import { EmployeePicker } from "@/components/people/employee-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { compareDecimal, errorText, moneyInput, today, trimDecimal, useCategories, withVersion, type Advance, type Category, type Claim, type FuelLog } from "@/lib/api/people";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const CLAIM_STATUSES = ["submitted", "approved", "paid", "rejected", "draft"];
const ADVANCE_STATUSES = ["requested", "approved", "paid", "settled", "rejected"];

function StatusFilter({ value, statuses, fallback, onChange }: { value: string; statuses: string[]; fallback: string; onChange: (v: string | null) => void }) {
  return (
    <Select value={value || fallback} onValueChange={(v) => onChange(v === fallback ? null : v)}>
      <SelectTrigger className="w-40" aria-label="Status"><SelectValue /></SelectTrigger>
      <SelectContent>
        {statuses.map((s) => <SelectItem key={s} value={s}>{s === "submitted" ? "Waiting for decision" : s === "requested" ? "Waiting for decision" : s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>)}
        <SelectItem value="any">Any status</SelectItem>
      </SelectContent>
    </Select>
  );
}

function Claims() {
  const url = useUrlState();
  const status = url.get("status") || "submitted";
  const search = url.get("q");
  const [draft, setDraft] = useState(search);
  const query = useQuery({
    queryKey: ["people", "claims", status, search, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/expenses/claims/", { params: { query: { status: status === "any" ? undefined : status, search: search || undefined, page: url.page } } })),
  });
  const columns: Column<Claim>[] = [
    { key: "claim", header: "Claim", cell: (c) => <span><span className="block">{c.employee_name}</span><span className="block text-xs font-normal text-muted-foreground">{c.number}</span></span> },
    { key: "purpose", header: "Purpose", cell: (c) => <span className="block max-w-[36ch] truncate">{c.purpose}</span>, className: "hidden md:table-cell" },
    { key: "date", header: "Date", cell: (c) => <span className="num whitespace-nowrap text-muted-foreground">{date(c.claim_date)}</span>, className: "hidden sm:table-cell" },
    { key: "amount", header: "Amount", align: "right", cell: (c) => <Amount value={c.amount} currency={c.currency} /> },
    { key: "status", header: "Status", cell: (c) => <DocStatus status={c.status} /> },
  ];
  return (
    <Section
      actions={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <form onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }} className="relative min-w-0 flex-1 sm:flex-none">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Number, purpose or employee" className="h-9 w-full pl-8 sm:w-60" aria-label="Search claims" />
          </form>
          <StatusFilter value={url.get("status")} statuses={CLAIM_STATUSES} fallback="submitted" onChange={(v) => url.set({ status: v })} />
        </div>
      }
    >
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
        rowHref={(c) => `/expenses/claims/${c.id}`} caption="Expense claims"
        empty={<EmptyState icon={Wallet} title={status === "submitted" ? "No claims are waiting for a decision" : "No claims match"} description="Employees file claims under My expenses." />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
    </Section>
  );
}

function Advances() {
  const url = useUrlState();
  const status = url.get("status") || "requested";
  const query = useQuery({
    queryKey: ["people", "advances", status, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/expenses/advances/", { params: { query: { status: status === "any" ? undefined : status, page: url.page } } })),
  });
  const columns: Column<Advance>[] = [
    { key: "adv", header: "Advance", cell: (a) => <span><span className="block">{a.employee_name}</span><span className="block text-xs font-normal text-muted-foreground">{a.number}</span></span> },
    { key: "purpose", header: "Purpose", cell: (a) => <span className="block max-w-[36ch] truncate">{a.purpose}</span>, className: "hidden md:table-cell" },
    { key: "amount", header: "Amount", align: "right", cell: (a) => <Amount value={a.amount} currency={a.currency} /> },
    { key: "out", header: "Outstanding", align: "right", cell: (a) => <Amount value={a.outstanding} currency={a.currency} />, className: "hidden sm:table-cell" },
    { key: "status", header: "Status", cell: (a) => <DocStatus status={a.status} /> },
  ];
  return (
    <Section actions={<StatusFilter value={url.get("status")} statuses={ADVANCE_STATUSES} fallback="requested" onChange={(v) => url.set({ status: v })} />}>
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
        rowHref={(a) => `/expenses/advances/${a.id}`} caption="Employee advances"
        empty={<EmptyState icon={HandCoins} title="No advances match" description="Employees request advances under My expenses; approved claims settle them." />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
    </Section>
  );
}

function RecordFuel() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ vehicle_registration: "", log_date: today(), odometer: "", litres: "", rate: "", driver: "", remarks: "" });
  const vehicle = form.vehicle_registration.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const last = useQuery({
    queryKey: ["people", "fuel-last", vehicle],
    queryFn: () => unwrap(api.GET("/api/v1/expenses/fuel-logs/", { params: { query: { vehicle_registration: vehicle, ordering: "-odometer", page_size: 1 } } })),
    enabled: open && vehicle.length >= 4,
  });
  const previous = last.data?.results[0];
  const tooLow = Boolean(previous && form.odometer && /^\d+(\.\d+)?$/.test(form.odometer) && previous.log_date <= form.log_date && compareDecimal(form.odometer, previous.odometer) <= 0);
  const save = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/expenses/fuel-logs/", { body: { ...form, vehicle_registration: vehicle } })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", "fuel"] });
      queryClient.invalidateQueries({ queryKey: ["people", "fuel-last"] });
      setOpen(false);
      setForm({ ...form, odometer: "", litres: "", remarks: "" });
      toast("Fuel log recorded");
    },
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus aria-hidden /> Fuel log</Button></DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Record a fuel fill</DialogTitle>
            <DialogDescription>Odometer readings must keep increasing for each vehicle.</DialogDescription>
          </DialogHeader>
          <FormError message={save.error && !isApiError(save.error, "validation_error") ? errorText(save.error) : errors._form} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="fl-vehicle" label="Vehicle registration" error={errors.vehicle_registration}><Input id="fl-vehicle" value={form.vehicle_registration} onChange={set("vehicle_registration")} className="uppercase" required maxLength={20} /></Field>
            <Field id="fl-date" label="Date" error={errors.log_date}><Input id="fl-date" type="date" value={form.log_date} onChange={set("log_date")} required /></Field>
            <Field id="fl-odo" label="Odometer (km)" error={errors.odometer ?? (tooLow ? `Must be above the last reading (${trimDecimal(previous!.odometer)} km on ${date(previous!.log_date)}).` : undefined)}
              hint={previous ? `Last: ${trimDecimal(previous.odometer)} km on ${date(previous.log_date)}` : undefined}>
              <Input id="fl-odo" inputMode="decimal" value={form.odometer} onChange={set("odometer")} required aria-invalid={tooLow} />
            </Field>
            <Field id="fl-litres" label="Litres" error={errors.litres}><Input id="fl-litres" inputMode="decimal" value={form.litres} onChange={set("litres")} required /></Field>
            <Field id="fl-rate" label="Rate per litre (₹)" error={errors.rate}><Input id="fl-rate" inputMode="decimal" value={form.rate} onChange={set("rate")} required /></Field>
          </div>
          <Field id="fl-driver" label="Driver" error={errors.driver}><EmployeePicker id="fl-driver" value={form.driver} onChange={(driver) => setForm({ ...form, driver })} /></Field>
          <Field id="fl-remarks" label="Remarks" error={errors.remarks}><Input id="fl-remarks" value={form.remarks} onChange={set("remarks")} maxLength={300} /></Field>
          <DialogFooter><Button type="submit" disabled={save.isPending || !form.driver || tooLow}>Record</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FuelLogs() {
  const { can } = useSession();
  const url = useUrlState();
  const vehicle = url.get("vehicle");
  const [draft, setDraft] = useState(vehicle);
  const query = useQuery({
    queryKey: ["people", "fuel", vehicle, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/expenses/fuel-logs/", { params: { query: { vehicle_registration: vehicle || undefined, page: url.page } } })),
  });
  const columns: Column<FuelLog>[] = [
    { key: "vehicle", header: "Vehicle", cell: (f) => <span><span className="block font-medium">{f.vehicle_registration}</span><span className="block text-xs text-muted-foreground">{date(f.log_date)}</span></span> },
    { key: "odo", header: "Odometer", align: "right", cell: (f) => <span className="num">{trimDecimal(f.odometer)} km</span> },
    { key: "litres", header: "Litres", align: "right", cell: (f) => <span className="num">{trimDecimal(f.litres)}</span>, className: "hidden sm:table-cell" },
    { key: "amount", header: "Amount", align: "right", cell: (f) => <Amount value={f.amount} /> },
    { key: "driver", header: "Driver", cell: (f) => f.driver_name, className: "hidden md:table-cell" },
    { key: "source", header: "Source", cell: (f) => <span className="text-muted-foreground">{f.claim_line ? "Expense claim" : "Manual"}</span>, className: "hidden lg:table-cell" },
  ];
  return (
    <Section
      actions={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <form onSubmit={(e) => { e.preventDefault(); url.set({ vehicle: draft.toUpperCase().replace(/[^A-Z0-9]/g, "") }); }} className="relative min-w-0 flex-1 sm:flex-none">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Vehicle registration" className="h-9 w-full pl-8 uppercase sm:w-52" aria-label="Filter by vehicle" />
          </form>
          {can("expenses.fuel_log.create") && <RecordFuel />}
        </div>
      }
    >
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch} caption="Fuel logs"
        empty={<EmptyState icon={Fuel} title="No fuel logs" description="Fuel claims create logs when approved; you can also record fills directly." />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
    </Section>
  );
}

function CategoryDialog({ category }: { category?: Category }) {
  const { activeCompany } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const init = () => ({
    code: category?.code ?? "", name: category?.name ?? "", gl_key: category?.gl_key ?? "expense_default",
    per_claim_limit: moneyInput(category?.per_claim_limit), receipt_required_above: moneyInput(category?.receipt_required_above),
    requires_vehicle: category?.requires_vehicle ?? false, is_active: category?.is_active ?? true,
  });
  const [form, setForm] = useState(init);
  const editable = {
    name: form.name.trim(), gl_key: form.gl_key.trim() || "expense_default",
    per_claim_limit: form.per_claim_limit.trim() || null, receipt_required_above: form.receipt_required_above.trim() || null,
    requires_vehicle: form.requires_vehicle, is_active: form.is_active,
  };
  const save = useMutation({
    mutationFn: () => category
      ? unwrap(api.PATCH("/api/v1/expenses/categories/{id}/", { params: { path: { id: category.id } }, body: withVersion(editable, category.version) }))
      : unwrap(api.POST("/api/v1/expenses/categories/", { body: { ...editable, code: form.code.trim(), company: activeCompany?.id ?? "" } })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", "expense-categories"] });
      setOpen(false);
      toast(category ? "Category saved" : "Category added");
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["people", "expense-categories"] });
    },
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  const set = (key: "code" | "name" | "gl_key" | "per_claim_limit" | "receipt_required_above") => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) { setForm(init()); save.reset(); } }}>
      <DialogTrigger asChild>
        {category ? <Button size="icon-sm" variant="ghost" aria-label={`Edit ${category.name}`}><Pencil aria-hidden /></Button> : <Button size="sm"><Plus aria-hidden /> Category</Button>}
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogHeader>
            <DialogTitle>{category ? `Edit ${category.name}` : "Add an expense category"}</DialogTitle>
            <DialogDescription>Limits and receipt thresholds are your policy data; claims are checked against them on submit.</DialogDescription>
          </DialogHeader>
          <FormError message={save.error && !isApiError(save.error, "validation_error") ? errorText(save.error) : errors._form} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="cat-code" label="Code" error={errors.code}><Input id="cat-code" value={form.code} onChange={set("code")} disabled={Boolean(category)} required maxLength={20} /></Field>
            <Field id="cat-name" label="Name" error={errors.name}><Input id="cat-name" value={form.name} onChange={set("name")} required maxLength={100} /></Field>
            <Field id="cat-limit" label="Per-claim limit (₹)" error={errors.per_claim_limit} hint="Blank = no limit"><Input id="cat-limit" inputMode="decimal" value={form.per_claim_limit} onChange={set("per_claim_limit")} /></Field>
            <Field id="cat-receipt" label="Receipt needed above (₹)" error={errors.receipt_required_above} hint="Blank = never required"><Input id="cat-receipt" inputMode="decimal" value={form.receipt_required_above} onChange={set("receipt_required_above")} /></Field>
            <Field id="cat-gl" label="GL key" error={errors.gl_key} hint="Account determination key, e.g. expense_default" className="sm:col-span-2"><Input id="cat-gl" value={form.gl_key} onChange={set("gl_key")} maxLength={40} /></Field>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
            <Label htmlFor="cat-vehicle" className="font-normal">Fuel: needs vehicle, odometer and litres</Label>
            <Switch id="cat-vehicle" checked={form.requires_vehicle} onCheckedChange={(requires_vehicle) => setForm({ ...form, requires_vehicle })} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
            <Label htmlFor="cat-active" className="font-normal">Active</Label>
            <Switch id="cat-active" checked={form.is_active} onCheckedChange={(is_active) => setForm({ ...form, is_active })} />
          </div>
          <DialogFooter><Button type="submit" disabled={save.isPending}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Categories() {
  const { can } = useSession();
  const categories = useCategories();
  const columns: Column<Category>[] = [
    { key: "name", header: "Category", cell: (c) => <span><span className="block">{c.name}</span><span className="block text-xs text-muted-foreground">{c.code}{c.requires_vehicle ? " · fuel" : ""}</span></span> },
    { key: "limit", header: "Per-claim limit", align: "right", cell: (c) => (c.per_claim_limit ? <Amount value={c.per_claim_limit} /> : "No limit") },
    { key: "receipt", header: "Receipt above", align: "right", cell: (c) => (c.receipt_required_above ? <Amount value={c.receipt_required_above} /> : "—"), className: "hidden sm:table-cell" },
    { key: "gl", header: "GL key", cell: (c) => <code className="text-xs">{c.gl_key}</code>, className: "hidden md:table-cell" },
    { key: "active", header: "Status", cell: (c) => <ActiveStatus active={c.is_active ?? true} />, className: "hidden sm:table-cell" },
    { key: "edit", header: <span className="sr-only">Edit</span>, align: "right", cell: (c) => (can("expenses.expense_category.update") ? <CategoryDialog key={c.version} category={c} /> : null) },
  ];
  return (
    <Section actions={can("expenses.expense_category.create") && <CategoryDialog />}>
      <DataTable columns={columns} rows={categories.data?.results} isLoading={categories.isLoading} error={categories.error} onRetry={categories.refetch} caption="Expense categories"
        empty={<EmptyState icon={Tags} title="No categories yet" description="Add categories such as travel, meals and fuel with their limits." />} />
    </Section>
  );
}

export function ExpensesView() {
  const { can } = useSession();
  const url = useUrlState();
  const tabs = [
    can("expenses.expense_claim.read") && { value: "claims", label: "Claims" },
    can("expenses.employee_advance.read") && { value: "advances", label: "Advances" },
    can("expenses.fuel_log.read") && { value: "fuel", label: "Fuel logs" },
    can("expenses.expense_category.read") && { value: "categories", label: "Categories" },
  ].filter(Boolean) as { value: string; label: string }[];
  const tab = url.get("tab") || tabs[0]?.value || "claims";
  return (
    <>
      <PageHeader title="Expense claims" description="Review and decide claims and advances, record reimbursements, and keep fuel logs and policy limits." />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v, status: null, q: null, vehicle: null })}>
        <TabStrip>
          <TabsList>{tabs.map((t) => <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>)}</TabsList>
        </TabStrip>
      </Tabs>
      {tab === "claims" && <Claims />}
      {tab === "advances" && <Advances />}
      {tab === "fuel" && <FuelLogs />}
      {tab === "categories" && <Categories />}
    </>
  );
}
