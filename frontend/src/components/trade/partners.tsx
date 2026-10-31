"use client";

import { useQuery } from "@tanstack/react-query";
import { Building2, Landmark, Plus, Search } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState, ErrorState, PageSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { tradeKey, type Partner, type PartnerKind } from "@/lib/api/trade";
import { date, money } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

import { ActionError, DocStatus, Notice } from "./common";
import { trim } from "./decimal";
import { StatusFilter, useTradeAction } from "./layout";
import { stateName, StateSelect } from "./pickers";

type GstRegistration = components["schemas"]["GstRegistrationEnum"];
type BankAccount = components["schemas"]["BankAccount"];

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const REGISTRATIONS: [GstRegistration, string][] = [
  ["regular", "Regular (GSTIN required)"], ["composition", "Composition"], ["unregistered", "Unregistered"], ["overseas", "Overseas"], ["sez", "SEZ"],
];

const COPY = {
  supplier: { title: "Suppliers", one: "supplier", href: "/partners/suppliers", read: "partners.supplier.read" },
  customer: { title: "Customers", one: "customer", href: "/partners/customers", read: "partners.customer.read" },
} as const;

type PartnerForm = {
  code: string; name: string; legal_name: string; gst_registration: GstRegistration; gstin: string; pan: string;
  state_code: string; email: string; phone: string; is_supplier: boolean; is_customer: boolean; is_blocked: boolean;
  blocked_reason: string; is_active: boolean;
};

function formFrom(p: Partner | null, kind: PartnerKind): PartnerForm {
  return {
    code: p?.code ?? "", name: p?.name ?? "", legal_name: p?.legal_name ?? "", gst_registration: p?.gst_registration ?? "regular",
    gstin: p?.gstin ?? "", pan: p?.pan ?? "", state_code: p?.state_code ?? "", email: p?.email ?? "", phone: p?.phone ?? "",
    is_supplier: p ? !!p.is_supplier : kind === "supplier", is_customer: p ? !!p.is_customer : kind === "customer",
    is_blocked: !!p?.is_blocked, blocked_reason: p?.blocked_reason ?? "", is_active: p ? p.is_active !== false : true,
  };
}

/** Client checks that mirror the database constraints, so mistakes show next to the field. */
function gstProblems(f: PartnerForm): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.gst_registration === "regular" && !f.gstin) out.gstin = "A regular GST registration needs a GSTIN.";
  if (f.gstin && !GSTIN_RE.test(f.gstin)) out.gstin = "A GSTIN has 15 characters, e.g. 27AAACB1234C1Z5.";
  if (f.gstin && f.state_code && GSTIN_RE.test(f.gstin) && f.gstin.slice(0, 2) !== f.state_code)
    out.state_code = `The GSTIN belongs to state ${f.gstin.slice(0, 2)}.`;
  if (f.pan && !PAN_RE.test(f.pan)) out.pan = "A PAN has 10 characters, e.g. AAACB1234C.";
  if (!f.is_supplier && !f.is_customer) out.roles = "Choose supplier, customer or both.";
  return out;
}

function PartnerFields({ form, setForm, errors, isNew }: { form: PartnerForm; setForm: (f: PartnerForm) => void; errors: Record<string, string>; isNew: boolean }) {
  const set = (key: keyof PartnerForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });
  const onGstin = (e: React.ChangeEvent<HTMLInputElement>) => {
    const gstin = e.target.value.toUpperCase().replace(/\s/g, "");
    const next = { ...form, gstin };
    if (GSTIN_RE.test(gstin)) {
      next.state_code = gstin.slice(0, 2); // the GSTIN decides the state for GST
      if (!form.pan) next.pan = gstin.slice(2, 12);
    }
    setForm(next);
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="p-code" label="Code" error={errors.code}>
        <Input id="p-code" value={form.code} onChange={set("code")} disabled={!isNew} required maxLength={30} className="num" />
      </Field>
      <Field id="p-name" label="Name" error={errors.name}><Input id="p-name" value={form.name} onChange={set("name")} required maxLength={200} /></Field>
      <Field id="p-legal" label="Legal name" error={errors.legal_name} className="sm:col-span-2">
        <Input id="p-legal" value={form.legal_name} onChange={set("legal_name")} maxLength={250} />
      </Field>
      <Field id="p-reg" label="GST registration" error={errors.gst_registration}>
        <Select value={form.gst_registration} onValueChange={(v) => setForm({ ...form, gst_registration: v as GstRegistration })}>
          <SelectTrigger id="p-reg" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{REGISTRATIONS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field id="p-gstin" label="GSTIN" error={errors.gstin} hint="Fills the state and PAN.">
        <Input id="p-gstin" value={form.gstin} onChange={onGstin} maxLength={15} className="num uppercase" autoComplete="off" />
      </Field>
      <Field id="p-state" label="State (place of supply)" error={errors.state_code}>
        <StateSelect id="p-state" value={form.state_code} onChange={(v) => setForm({ ...form, state_code: v })} />
      </Field>
      <Field id="p-pan" label="PAN" error={errors.pan}>
        <Input id="p-pan" value={form.pan} onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })} maxLength={10} className="num uppercase" />
      </Field>
      <Field id="p-email" label="Email" error={errors.email}><Input id="p-email" type="email" value={form.email} onChange={set("email")} /></Field>
      <Field id="p-phone" label="Phone" error={errors.phone}><Input id="p-phone" value={form.phone} onChange={set("phone")} maxLength={30} /></Field>
      <fieldset className="grid min-w-0 gap-2 sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">Roles</legend>
        <div className="flex flex-wrap gap-5">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.is_supplier} onCheckedChange={(v) => setForm({ ...form, is_supplier: v === true })} /> Supplier</label>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.is_customer} onCheckedChange={(v) => setForm({ ...form, is_customer: v === true })} /> Customer</label>
        </div>
        {errors.roles && <p className="text-sm text-destructive">{errors.roles}</p>}
      </fieldset>
    </div>
  );
}

function NewPartner({ kind }: { kind: PartnerKind }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PartnerForm>(() => formFrom(null, kind));
  const [touched, setTouched] = useState(false);
  const local = gstProblems(form);
  const create = useTradeAction(
    () => unwrap(api.POST("/api/v1/partners/", { body: { ...form } })),
    (p) => {
      toast(`${p.name} added${kind === "supplier" ? ". Another person must approve the supplier before it can be ordered from." : "."}`);
      setOpen(false);
      router.push(`${COPY[kind].href}/${p.id}`);
    },
  );
  const errors = { ...(touched ? local : {}), ...(isApiError(create.error) ? create.error.fieldErrors() : {}) };
  return (
    <>
      <Button onClick={() => { setForm(formFrom(null, kind)); setTouched(false); create.reset(); setOpen(true); }}>
        <Plus aria-hidden /> New {COPY[kind].one}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); setTouched(true); if (Object.keys(local).length === 0) create.mutate(undefined); }}>
            <DialogHeader>
              <DialogTitle>New {COPY[kind].one}</DialogTitle>
              <DialogDescription>
                {kind === "supplier" ? "New suppliers can't be ordered from until another person approves them (maker-checker)." : "Set credit terms on the customer page after saving."}
              </DialogDescription>
            </DialogHeader>
            <ActionError error={create.error} />
            <PartnerFields form={form} setForm={setForm} errors={errors} isNew />
            <DialogFooter><Button type="submit" disabled={create.isPending}>Save {COPY[kind].one}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PartnerState({ p, kind }: { p: Partner; kind: PartnerKind }) {
  return (
    <span className="flex flex-wrap gap-1">
      {p.is_active === false && <StatusBadge tone="neutral">Inactive</StatusBadge>}
      {p.is_blocked && <StatusBadge tone="rejected">Blocked</StatusBadge>}
      {kind === "supplier" && (p.supplier_profile?.is_approved_vendor
        ? <StatusBadge tone="approved">Approved vendor</StatusBadge>
        : <StatusBadge tone="pending">Awaiting approval</StatusBadge>)}
      {kind === "customer" && p.customer_profile?.on_credit_hold && <StatusBadge tone="rejected">Credit hold</StatusBadge>}
    </span>
  );
}

export function PartnerList({ kind }: { kind: PartnerKind }) {
  const { can } = useSession();
  const url = useUrlState();
  const search = url.get("q");
  const [draft, setDraft] = useState(search);
  const state = url.get("state");
  const query = useQuery({
    queryKey: tradeKey("partners", "list", kind, search, state, url.page),
    queryFn: () =>
      unwrap(api.GET("/api/v1/partners/", {
        params: {
          query: {
            ...(kind === "supplier" ? { is_supplier: true } : { is_customer: true }),
            search: search || undefined, page: url.page,
            is_blocked: state === "blocked" ? true : undefined, is_active: state === "inactive" ? false : state === "" ? undefined : true,
          },
        },
      })),
  });
  const columns: Column<Partner>[] = [
    { key: "name", header: "Name", cell: (p) => <span><span className="block">{p.name}</span><span className="num block text-xs font-normal text-muted-foreground">{p.code}</span></span> },
    { key: "gstin", header: "GSTIN", cell: (p) => <span className="num">{p.gstin || <span className="text-muted-foreground">{p.gst_registration}</span>}</span> },
    { key: "state", header: "State", cell: (p) => (p.state_code ? `${p.state_code} · ${stateName(p.state_code)}` : "—") },
    ...(kind === "customer"
      ? [{ key: "credit", header: "Credit limit", align: "right" as const, cell: (p: Partner) => <span className="num">{p.customer_profile ? money(p.customer_profile.credit_limit) : "—"}</span> },
        { key: "days", header: "Credit days", align: "right" as const, cell: (p: Partner) => <span className="num">{p.customer_profile?.credit_days ?? "—"}</span> }]
      : [{ key: "terms", header: "Payment terms", align: "right" as const, cell: (p: Partner) => <span className="num">{p.supplier_profile ? `${p.supplier_profile.payment_terms_days ?? "—"} days` : "—"}</span> }]),
    { key: "status", header: "Status", cell: (p) => <PartnerState p={p} kind={kind} /> },
  ];
  return (
    <>
      <PageHeader title={COPY[kind].title}
        description={kind === "supplier" ? "Vendors you buy from: GST details, terms, approval and verified bank accounts." : "Who you sell to: GST details and credit terms used by the order credit check."}
        actions={can("partners.partner.create") && <NewPartner kind={kind} />} />
      <Section actions={
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }} className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Code, name or GSTIN" className="h-9 w-56 max-w-full pl-8" aria-label={`Search ${COPY[kind].title.toLowerCase()}`} />
          </form>
          <StatusFilter value={state || "active"} onChange={(v) => url.set({ state: v === "active" ? null : v })}
            options={[["active", "Active"], ["blocked", "Blocked"], ["inactive", "Inactive"]]} />
        </div>
      }>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(p) => `${COPY[kind].href}/${p.id}`} caption={COPY[kind].title}
          empty={<EmptyState icon={Building2} title={`No ${COPY[kind].title.toLowerCase()} match`} description={search ? "Try another search." : undefined} />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}

function DetailsForm({ p }: { p: Partner }) {
  const { can } = useSession();
  const [form, setForm] = useState<PartnerForm>(() => formFrom(p, "supplier"));
  const [synced, setSynced] = useState(p.version);
  if (p.version !== synced) { setSynced(p.version); setForm(formFrom(p, "supplier")); }
  const local = gstProblems(form);
  const save = useTradeAction(() => {
    const { code: _code, ...rest } = form;
    void _code;
    const body = { ...rest, version: p.version };
    return unwrap(api.PATCH("/api/v1/partners/{id}/", { params: { path: { id: p.id } }, body }));
  }, () => toast("Partner details saved"));
  const editable = can("partners.partner.update");
  return (
    <Section title="Details" description="GSTIN and state decide whether documents carry CGST + SGST or IGST.">
      <form className="grid gap-4 px-5 py-4" onSubmit={(e) => { e.preventDefault(); if (Object.keys(local).length === 0) save.mutate(undefined); }}>
        <ActionError error={save.error} />
        <fieldset disabled={!editable} className="grid min-w-0 gap-4">
          <PartnerFields form={form} setForm={setForm} errors={local} isNew={false} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <Label htmlFor="p-blocked" className="font-normal">Blocked for new documents</Label>
              <Switch id="p-blocked" checked={form.is_blocked} onCheckedChange={(v) => setForm({ ...form, is_blocked: v })} />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <Label htmlFor="p-active" className="font-normal">Active</Label>
              <Switch id="p-active" checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
            </div>
            {form.is_blocked && (
              <Field id="p-blocked-reason" label="Reason for blocking" className="sm:col-span-2">
                <Input id="p-blocked-reason" value={form.blocked_reason} onChange={(e) => setForm({ ...form, blocked_reason: e.target.value })} maxLength={300} />
              </Field>
            )}
          </div>
        </fieldset>
        {editable && <div><Button type="submit" disabled={save.isPending}>Save details</Button></div>}
      </form>
    </Section>
  );
}

function SupplierSection({ p }: { p: Partner }) {
  const { can } = useSession();
  const profile = p.supplier_profile;
  const [terms, setTerms] = useState(() => ({
    payment_terms_days: String(profile?.payment_terms_days ?? ""), currency: profile?.currency ?? "INR",
    default_lead_time_days: String(profile?.default_lead_time_days ?? ""), tds_section: profile?.tds_section ?? "",
  }));
  const approve = useTradeAction((ok: boolean) =>
    unwrap(api.POST("/api/v1/partners/{id}/approve-supplier/", { params: { path: { id: p.id } }, body: { approve: ok, note: "" } })),
  (_d, ok) => toast(ok ? "Supplier approved" : "Supplier approval withdrawn"));
  const saveTerms = useTradeAction(() =>
    unwrap(api.PATCH("/api/v1/partners/{id}/supplier-terms/", {
      params: { path: { id: p.id } },
      body: {
        payment_terms_days: terms.payment_terms_days === "" ? undefined : Number(terms.payment_terms_days),
        default_lead_time_days: terms.default_lead_time_days === "" ? undefined : Number(terms.default_lead_time_days),
        currency: terms.currency, tds_section: terms.tds_section,
      },
    })), () => toast("Supplier terms saved"));
  if (!profile) {
    return (
      <Section title="Supplier">
        <div className="px-5 py-4"><Notice tone="pending">This partner has no supplier profile yet, so it can&apos;t be approved or ordered from.</Notice></div>
      </Section>
    );
  }
  return (
    <Section title="Supplier" description="Approval is maker-checker: the person who created the supplier can't approve it."
      actions={<span className="flex items-center gap-2">
        {profile.is_approved_vendor ? <StatusBadge tone="approved">Approved vendor</StatusBadge> : <StatusBadge tone="pending">Awaiting approval</StatusBadge>}
      </span>}>
      <div className="grid gap-4 px-5 py-4">
        {can("partners.supplier.approve") && (
          <div className="grid gap-2">
            <ActionError error={approve.error} hints={{ permission_denied: "You can't approve this supplier: you need supplier approval rights for this company." }} />
            <div className="flex flex-wrap gap-2">
              {!profile.is_approved_vendor
                ? <Button onClick={() => approve.mutate(true)} disabled={approve.isPending}>Approve supplier</Button>
                : <Button variant="outline" onClick={() => approve.mutate(false)} disabled={approve.isPending}>Withdraw approval</Button>}
            </div>
          </div>
        )}
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); saveTerms.mutate(undefined); }}>
          <ActionError error={saveTerms.error} />
          <fieldset disabled={!can("partners.supplier.update")} className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Field id="s-terms" label="Payment terms (days)"><Input id="s-terms" inputMode="numeric" className="num" value={terms.payment_terms_days} onChange={(e) => setTerms({ ...terms, payment_terms_days: e.target.value.replace(/\D/g, "") })} /></Field>
            <Field id="s-lead" label="Lead time (days)"><Input id="s-lead" inputMode="numeric" className="num" value={terms.default_lead_time_days} onChange={(e) => setTerms({ ...terms, default_lead_time_days: e.target.value.replace(/\D/g, "") })} /></Field>
            <Field id="s-cur" label="Currency"><Input id="s-cur" maxLength={3} className="num uppercase" value={terms.currency} onChange={(e) => setTerms({ ...terms, currency: e.target.value.toUpperCase() })} /></Field>
            <Field id="s-tds" label="TDS section"><Input id="s-tds" maxLength={10} value={terms.tds_section} onChange={(e) => setTerms({ ...terms, tds_section: e.target.value })} /></Field>
          </fieldset>
          <p className="text-sm text-muted-foreground">Rating: <span className="num">{profile.rating ? trim(profile.rating) : "not rated yet"}</span></p>
          {can("partners.supplier.update") && <div><Button type="submit" variant="outline" disabled={saveTerms.isPending}>Save terms</Button></div>}
        </form>
      </div>
    </Section>
  );
}

function CustomerSection({ p }: { p: Partner }) {
  const { can } = useSession();
  const profile = p.customer_profile;
  const [form, setForm] = useState(() => ({
    credit_limit: profile?.credit_limit ? trim(profile.credit_limit) : "0", credit_days: String(profile?.credit_days ?? 30), on_credit_hold: !!profile?.on_credit_hold,
  }));
  const save = useTradeAction(() =>
    unwrap(api.PATCH("/api/v1/partners/{id}/customer-terms/", {
      params: { path: { id: p.id } },
      body: { credit_limit: form.credit_limit, credit_days: Number(form.credit_days || 0), on_credit_hold: form.on_credit_hold },
    })), () => toast("Credit settings saved"));
  if (!profile) {
    return <Section title="Credit"><div className="px-5 py-4"><Notice tone="pending">This partner has no customer profile yet, so it can&apos;t be sold to.</Notice></div></Section>;
  }
  const editable = can("partners.customer.update");
  return (
    <Section title="Credit" description="Orders are checked against the limit (open invoices plus open orders) and overdue invoices when submitted."
      actions={profile.on_credit_hold ? <StatusBadge tone="rejected">Credit hold</StatusBadge> : undefined}>
      <form className="grid gap-4 px-5 py-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <ActionError error={save.error} />
        <fieldset disabled={!editable} className="grid min-w-0 gap-4 sm:grid-cols-3">
          <Field id="c-limit" label="Credit limit (₹)"><Input id="c-limit" inputMode="decimal" className="num" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value.replace(/[^\d.]/g, "") })} /></Field>
          <Field id="c-days" label="Credit days"><Input id="c-days" inputMode="numeric" className="num" value={form.credit_days} onChange={(e) => setForm({ ...form, credit_days: e.target.value.replace(/\D/g, "") })} /></Field>
          <div className="flex items-center justify-between self-end rounded-md border px-3 py-2">
            <Label htmlFor="c-hold" className="font-normal">On credit hold</Label>
            <Switch id="c-hold" checked={form.on_credit_hold} onCheckedChange={(v) => setForm({ ...form, on_credit_hold: v })} />
          </div>
        </fieldset>
        {editable && <div><Button type="submit" variant="outline" disabled={save.isPending}>Save credit settings</Button></div>}
      </form>
    </Section>
  );
}

function BankAccounts({ p }: { p: Partner }) {
  const { can, me } = useSession();
  const { withStepUp } = useStepUp();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ bank_name: "", ifsc: "", account_holder: "", account_number: "" });
  const [reviewing, setReviewing] = useState<{ account: BankAccount; approve: boolean } | null>(null);
  const [note, setNote] = useState("");
  const accounts = useQuery({
    queryKey: tradeKey("partners", p.id, "bank-accounts"),
    queryFn: () => unwrap(api.GET("/api/v1/partners/{id}/bank-accounts/", { params: { path: { id: p.id } } })),
  });
  const add = useTradeAction(() =>
    unwrap(api.POST("/api/v1/partners/{id}/bank-accounts/", { params: { path: { id: p.id } }, body: form })),
  () => { toast("Bank account added. Another person must verify it before payments can use it."); setAdding(false); setForm({ bank_name: "", ifsc: "", account_holder: "", account_number: "" }); });
  const review = useTradeAction(() => {
    const r = reviewing!;
    return withStepUp(() => unwrap(api.POST("/api/v1/partners/{id}/bank-accounts/{account_id}/review/", {
      params: { path: { id: p.id, account_id: r.account.id } }, body: { approve: r.approve, note },
    })));
  }, () => { toast(reviewing?.approve ? "Bank account verified" : "Bank account rejected"); setReviewing(null); setNote(""); });
  const canApprove = can("partners.bank_account.approve");

  const columns: Column<BankAccount>[] = [
    { key: "bank", header: "Bank", cell: (a) => <span><span className="block">{a.bank_name}</span><span className="num block text-xs text-muted-foreground">{a.ifsc}</span></span> },
    { key: "holder", header: "Account holder", cell: (a) => a.account_holder },
    { key: "number", header: "Account", cell: (a) => <span className="num" aria-label={`Account ending ${a.masked_number.slice(-4)}`}>{a.masked_number}</span> },
    { key: "status", header: "Status", cell: (a) => <span className="grid gap-0.5"><DocStatus status={a.status} />{a.review_note && <span className="text-xs text-muted-foreground">{a.review_note}</span>}</span> },
    { key: "added", header: "Added", cell: (a) => <span className="text-muted-foreground">{date(a.created_at)}</span> },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (a) => a.status !== "pending_verification" ? null
      : a.created_by === me.user.id ? <span className="text-xs text-muted-foreground">Another person verifies</span>
      : canApprove ? (
        <span className="flex justify-end gap-1">
          <Button size="sm" variant="outline" onClick={() => { review.reset(); setReviewing({ account: a, approve: true }); }}>Verify</Button>
          <Button size="sm" variant="ghost" onClick={() => { review.reset(); setReviewing({ account: a, approve: false }); }}>Reject</Button>
        </span>
      ) : null },
  ];

  return (
    <Section title="Bank accounts" description="Only the last four digits are ever shown. New accounts need verification by someone other than the person who entered them."
      actions={can("partners.bank_account.update") && <Button size="sm" variant="outline" onClick={() => { add.reset(); setAdding(true); }}><Plus aria-hidden /> Add account</Button>}>
      <DataTable columns={columns} rows={accounts.data} isLoading={accounts.isLoading} error={accounts.error} onRetry={accounts.refetch}
        empty={<EmptyState icon={Landmark} title="No bank accounts" />} />
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-md">
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined); }}>
            <DialogHeader><DialogTitle>Add bank account</DialogTitle><DialogDescription>Stored encrypted. After saving only the last four digits are shown.</DialogDescription></DialogHeader>
            <ActionError error={add.error} />
            <Field id="b-bank" label="Bank name"><Input id="b-bank" value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} required /></Field>
            <Field id="b-ifsc" label="IFSC" hint="11 characters, e.g. HDFC0001234"><Input id="b-ifsc" className="num uppercase" maxLength={11} value={form.ifsc} onChange={(e) => setForm({ ...form, ifsc: e.target.value.toUpperCase() })} required pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}" /></Field>
            <Field id="b-holder" label="Account holder"><Input id="b-holder" value={form.account_holder} onChange={(e) => setForm({ ...form, account_holder: e.target.value })} required /></Field>
            <Field id="b-number" label="Account number"><Input id="b-number" className="num" autoComplete="off" inputMode="numeric" value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} required /></Field>
            <DialogFooter><Button type="submit" disabled={add.isPending}>Add account</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!reviewing} onOpenChange={(o) => !o && setReviewing(null)}>
        <DialogContent className="sm:max-w-md">
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); review.mutate(undefined); }}>
            <DialogHeader>
              <DialogTitle>{reviewing?.approve ? "Verify bank account" : "Reject bank account"}</DialogTitle>
              <DialogDescription>{reviewing?.account.bank_name} {reviewing?.account.masked_number}. Verifying needs a fresh two-step verification and retires any older verified account.</DialogDescription>
            </DialogHeader>
            <ActionError error={review.error} hints={{ permission_denied: "You can't review this account: you need bank account verification rights." }} />
            <Field id="b-note" label="Note" hint="How you checked it, e.g. cancelled cheque or bank letter."><Textarea id="b-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
            <DialogFooter><Button type="submit" disabled={review.isPending}>{reviewing?.approve ? "Verify" : "Reject"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function AddressesAndContacts({ p }: { p: Partner }) {
  const { can } = useSession();
  const [mode, setMode] = useState<"address" | "contact" | null>(null);
  const [addr, setAddr] = useState({ kind: "billing" as "billing" | "shipping", line1: "", line2: "", city: "", state_code: p.state_code ?? "", pincode: "", is_default: true });
  const [contact, setContact] = useState({ name: "", role: "", email: "", phone: "" });
  const save = useTradeAction(() => mode === "address"
    ? unwrap(api.POST("/api/v1/partners/{id}/addresses/", { params: { path: { id: p.id } }, body: addr }))
    : unwrap(api.POST("/api/v1/partners/{id}/contacts/", { params: { path: { id: p.id } }, body: contact })),
  () => { toast(mode === "address" ? "Address added" : "Contact added"); setMode(null); });
  const editable = can("partners.partner.update");
  return (
    <Section title="Addresses and contacts" actions={editable && (
      <span className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => { save.reset(); setMode("address"); }}><Plus aria-hidden /> Address</Button>
        <Button size="sm" variant="outline" onClick={() => { save.reset(); setMode("contact"); }}><Plus aria-hidden /> Contact</Button>
      </span>
    )}>
      <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase">Addresses</p>
          {p.addresses.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : (
            <ul className="grid gap-2 text-sm">{p.addresses.map((a) => (
              <li key={a.id} className="rounded-md border px-3 py-2">
                <span className="text-xs text-muted-foreground">{a.kind}{a.is_default ? " · default" : ""}</span>
                <span className="block">{a.line1}{a.line2 ? `, ${a.line2}` : ""}</span>
                <span className="block">{a.city} {a.pincode} · {stateName(a.state_code)}</span>
              </li>
            ))}</ul>
          )}
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase">Contacts</p>
          {p.contacts.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : (
            <ul className="grid gap-2 text-sm">{p.contacts.map((c) => (
              <li key={c.id} className="rounded-md border px-3 py-2">
                <span className="block font-medium">{c.name}{c.role ? <span className="font-normal text-muted-foreground"> · {c.role}</span> : null}</span>
                <span className="block break-all text-muted-foreground">{[c.email, c.phone].filter(Boolean).join(" · ") || "—"}</span>
              </li>
            ))}</ul>
          )}
        </div>
      </div>
      <Dialog open={mode !== null} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent className="sm:max-w-md">
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
            <DialogHeader><DialogTitle>{mode === "address" ? "Add address" : "Add contact"}</DialogTitle></DialogHeader>
            <ActionError error={save.error} />
            {mode === "address" ? (
              <>
                <Field id="a-kind" label="Kind">
                  <Select value={addr.kind} onValueChange={(v) => setAddr({ ...addr, kind: v as "billing" | "shipping" })}>
                    <SelectTrigger id="a-kind" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="billing">Billing</SelectItem><SelectItem value="shipping">Shipping</SelectItem></SelectContent>
                  </Select>
                </Field>
                <Field id="a-line1" label="Address line 1"><Input id="a-line1" value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} required /></Field>
                <Field id="a-line2" label="Address line 2"><Input id="a-line2" value={addr.line2} onChange={(e) => setAddr({ ...addr, line2: e.target.value })} /></Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="a-city" label="City"><Input id="a-city" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} required /></Field>
                  <Field id="a-pin" label="PIN code"><Input id="a-pin" inputMode="numeric" className="num" value={addr.pincode} onChange={(e) => setAddr({ ...addr, pincode: e.target.value })} required /></Field>
                </div>
                <Field id="a-state" label="State"><StateSelect id="a-state" value={addr.state_code} onChange={(v) => setAddr({ ...addr, state_code: v })} /></Field>
              </>
            ) : (
              <>
                <Field id="ct-name" label="Name"><Input id="ct-name" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} required /></Field>
                <Field id="ct-role" label="Role"><Input id="ct-role" value={contact.role} onChange={(e) => setContact({ ...contact, role: e.target.value })} /></Field>
                <Field id="ct-email" label="Email"><Input id="ct-email" type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} /></Field>
                <Field id="ct-phone" label="Phone"><Input id="ct-phone" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} /></Field>
              </>
            )}
            <DialogFooter><Button type="submit" disabled={save.isPending}>Save</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

export function PartnerDetail({ kind }: { kind: PartnerKind }) {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const query = useQuery({
    queryKey: tradeKey("partners", id),
    queryFn: () => unwrap(api.GET("/api/v1/partners/{id}/", { params: { path: { id } } })),
  });
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const p = query.data!;
  return (
    <>
      <PageHeader crumbs={[{ label: COPY[kind].title, href: COPY[kind].href }, { label: p.code }]} title={p.name}
        meta={<>
          <span className="num text-muted-foreground">{p.code}</span>
          {p.gstin && <span className="num">GSTIN {p.gstin}</span>}
          <span className="text-muted-foreground">{p.state_code ? `${p.state_code} · ${stateName(p.state_code)}` : "No state"}</span>
          <PartnerState p={p} kind={kind} />
        </>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <DetailsForm key={p.id} p={p} />
          <AddressesAndContacts p={p} />
        </div>
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          {p.is_supplier && <SupplierSection key={`s-${p.id}-${p.supplier_profile ? "y" : "n"}`} p={p} />}
          {p.is_customer && <CustomerSection key={`c-${p.id}-${p.customer_profile ? "y" : "n"}`} p={p} />}
          {can("partners.bank_account.read") && <BankAccounts p={p} />}
        </div>
      </div>
    </>
  );
}

