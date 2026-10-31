"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Pause, Play, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { OneTimeSecret } from "@/components/erp/one-time-secret";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState, ErrorState } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { temporaryPassword } from "@/lib/temporary-password";

type Organization = components["schemas"]["OrganizationSummary"];

const CODE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;
const ORGS_KEY = ["platform", "organizations"] as const;

function problemMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (isApiError(error, "mfa_required")) return "This needs a fresh two-step verification. Try again and enter your code.";
  return isApiError(error) ? error.summary() : "Couldn't reach the server.";
}

const EMPTY = {
  code: "", name: "", company_code: "", company_name: "", state_code: "", gstin: "", fiscal_start_year: "",
  admin_name: "", admin_email: "",
};

function CreateOrganization() {
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [password, setPassword] = useState(temporaryPassword);
  const [created, setCreated] = useState<{ org: Organization; email: string; password: string } | null>(null);

  const create = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/platform/organizations/", {
      body: {
        code: form.code.trim(),
        name: form.name.trim(),
        company_code: form.company_code.trim(),
        company_name: form.company_name.trim(),
        state_code: form.state_code.trim(),
        gstin: form.gstin.trim().toUpperCase(),
        ...(form.fiscal_start_year.trim() ? { fiscal_start_year: Number(form.fiscal_start_year.trim()) } : {}),
        admin_email: form.admin_email.trim(),
        admin_name: form.admin_name.trim(),
        admin_password: password,
      },
    }))),
    onSuccess: (org) => {
      queryClient.invalidateQueries({ queryKey: ORGS_KEY });
      setCreated({ org, email: form.admin_email.trim(), password });
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  const formError = create.error && !isApiError(create.error, "validation_error") ? problemMessage(create.error) : errors._form;

  const set = (key: keyof typeof EMPTY, upper = false) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: upper ? e.target.value.toUpperCase() : e.target.value });

  const local = {
    code: form.code && !CODE.test(form.code) ? "2–30 characters: capitals, digits, - or _, starting with a capital or digit." : undefined,
    company_code: form.company_code && !CODE.test(form.company_code) ? "2–30 characters: capitals, digits, - or _." : undefined,
    password: password.length < 12 ? "At least 12 characters." : undefined,
    year: form.fiscal_start_year && !/^\d{4}$/.test(form.fiscal_start_year.trim()) ? "A four-digit year, e.g. 2026." : undefined,
  };
  const invalid = Boolean(local.code || local.company_code || local.password || local.year);

  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setForm(EMPTY);
      setPassword(temporaryPassword());
      setCreated(null);
      create.reset();
    }
  };

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild><Button><Plus aria-hidden /> Create organization</Button></DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        {created ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{created.org.name} is ready</DialogTitle>
              <DialogDescription>
                Organization <span className="num">{created.org.code}</span> was created with its first company, fiscal year, role
                templates and chart of accounts.
              </DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Administrator</dt>
              <dd className="break-all">{created.email}</dd>
            </dl>
            <OneTimeSecret label="Temporary password" value={created.password}>
              <p>
                Send this to the administrator through a <strong>separate channel</strong> from the sign-in address (for example by phone,
                not in the same email). It is not shown again. At first sign-in they must set up two-step verification and choose a new password.
              </p>
            </OneTimeSecret>
            <DialogFooter><Button type="button" onClick={() => reset(false)}>Done</Button></DialogFooter>
          </div>
        ) : (
          <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); if (!invalid) create.mutate(); }}>
            <DialogHeader>
              <DialogTitle>Create an organization</DialogTitle>
              <DialogDescription>
                Sets up a new tenant ready to sign in to: the organization, its first company and fiscal year, role and policy templates,
                a template chart of accounts, and a first administrator.
              </DialogDescription>
            </DialogHeader>
            <FormError message={formError} />

            <fieldset className="grid gap-4">
              <legend className="type-section mb-3">Organization</legend>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <Field id="org-code" label="Code" error={errors.code ?? local.code} hint="Capitals and digits, e.g. ACME.">
                  <Input id="org-code" value={form.code} onChange={set("code", true)} required maxLength={30} className="num" autoComplete="off" />
                </Field>
                <Field id="org-name" label="Name" error={errors.name}>
                  <Input id="org-name" value={form.name} onChange={set("name")} required maxLength={200} />
                </Field>
              </div>
            </fieldset>

            <fieldset className="grid gap-4 border-t pt-4">
              <legend className="type-section mb-3 pt-4">First company</legend>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <Field id="company-code" label="Company code" error={errors.company_code ?? local.company_code}>
                  <Input id="company-code" value={form.company_code} onChange={set("company_code", true)} required maxLength={30} className="num" autoComplete="off" />
                </Field>
                <Field id="company-name" label="Legal name" error={errors.company_name}>
                  <Input id="company-name" value={form.company_name} onChange={set("company_name")} required maxLength={200} />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id="state-code" label="GST state code" error={errors.state_code} hint="Optional, e.g. 27.">
                  <Input id="state-code" value={form.state_code} onChange={set("state_code")} maxLength={2} inputMode="numeric" className="num" />
                </Field>
                <Field id="gstin" label="GSTIN" error={errors.gstin} hint="Optional.">
                  <Input id="gstin" value={form.gstin} onChange={set("gstin", true)} maxLength={15} className="num" autoComplete="off" />
                </Field>
                <Field id="fiscal-year" label="Fiscal year starts" error={errors.fiscal_start_year ?? local.year}
                  hint="Optional. Leave blank for the current fiscal year.">
                  <Input id="fiscal-year" value={form.fiscal_start_year} onChange={set("fiscal_start_year")} inputMode="numeric" maxLength={4} className="num" placeholder="e.g. 2026" />
                </Field>
              </div>
            </fieldset>

            <fieldset className="grid gap-4 border-t pt-4">
              <legend className="type-section mb-3 pt-4">First administrator</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="admin-name" label="Full name" error={errors.admin_name}>
                  <Input id="admin-name" value={form.admin_name} onChange={set("admin_name")} required maxLength={200} />
                </Field>
                <Field id="admin-email" label="Work email" error={errors.admin_email}>
                  <Input id="admin-email" type="email" value={form.admin_email} onChange={set("admin_email")} required autoComplete="off" />
                </Field>
              </div>
              <Field id="admin-password" label="Temporary password" error={errors.admin_password ?? local.password}
                hint="You'll see it once more after creating, to copy. They must replace it and set up two-step verification at first sign-in.">
                <div className="flex gap-2">
                  <Input id="admin-password" value={password} onChange={(e) => setPassword(e.target.value)} className="num" required minLength={12} autoComplete="off" />
                  <Button type="button" variant="outline" onClick={() => setPassword(temporaryPassword())}>New</Button>
                </div>
              </Field>
            </fieldset>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => reset(false)}>Cancel</Button>
              <Button type="submit" disabled={create.isPending || invalid}>{create.isPending ? "Creating…" : "Create organization"}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatusAction({ org }: { org: Organization }) {
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const suspend = org.is_active;
  const change = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/platform/organizations/{organization_id}/status/", {
      params: { path: { organization_id: org.id } },
      body: { active: !suspend, reason: reason.trim() },
    }))),
    onSuccess: (row) => {
      queryClient.invalidateQueries({ queryKey: ORGS_KEY });
      toast(`${row.name} ${row.is_active ? "reactivated" : "suspended"}`);
      setOpen(false);
      setReason("");
    },
  });
  const errors = isApiError(change.error) ? change.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setReason(""); change.reset(); } }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {suspend ? <Pause aria-hidden /> : <Play aria-hidden />} {suspend ? "Suspend" : "Reactivate"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
          <DialogHeader>
            <DialogTitle>{suspend ? `Suspend ${org.name}?` : `Reactivate ${org.name}?`}</DialogTitle>
            <DialogDescription>
              {suspend
                ? `All ${org.users} user${org.users === 1 ? "" : "s"} of this organization are signed out immediately and can't sign in until it is reactivated. Their data is kept untouched.`
                : "Its users can sign in again with their existing passwords and two-step verification."}
            </DialogDescription>
          </DialogHeader>
          <FormError message={change.error && !isApiError(change.error, "validation_error") ? problemMessage(change.error) : undefined} />
          <Field id={`reason-${org.id}`} label="Reason" error={errors.reason} hint="Recorded in the audit log.">
            <Textarea id={`reason-${org.id}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} required />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant={suspend ? "destructive" : "default"} disabled={!reason.trim() || change.isPending}>
              {suspend ? "Suspend and sign everyone out" : "Reactivate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PlatformView() {
  const { isOperator } = useSession();
  const { withStepUp } = useStepUp();
  const query = useQuery({
    queryKey: ORGS_KEY,
    queryFn: () => withStepUp(() => unwrap(api.GET("/api/v1/platform/organizations/"))),
    enabled: isOperator,
    // Every platform call needs a recent MFA check; don't pop the code dialog on a background refetch.
    refetchOnWindowFocus: false,
  });

  if (!isOperator) {
    return (
      <>
        <PageHeader title="Organizations" />
        <Section><ErrorState error={new ApiError(403, undefined)} /></Section>
      </>
    );
  }

  const columns: Column<Organization>[] = [
    { key: "code", header: "Code", cell: (o) => <span className="num font-medium">{o.code}</span> },
    { key: "name", header: "Name", cell: (o) => <span className="block min-w-40">{o.name}<span className="block text-xs text-muted-foreground">{o.base_currency} · {o.timezone}</span></span> },
    { key: "status", header: "Status", cell: (o) => o.is_active ? <StatusBadge tone="approved">Active</StatusBadge> : <StatusBadge tone="rejected">Suspended</StatusBadge> },
    { key: "users", header: "Users", align: "right", cell: (o) => <span className="num">{o.users}</span> },
    { key: "companies", header: "Companies", align: "right", cell: (o) => <span className="num">{o.companies}</span> },
    { key: "created", header: "Created", cell: (o) => <span className="whitespace-nowrap text-muted-foreground">{date(o.created_at)}</span> },
    { key: "action", header: <span className="sr-only">Actions</span>, align: "right", cell: (o) => <StatusAction org={o} /> },
  ];

  const needsMfa = isApiError(query.error, "mfa_required");
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Platform" }, { label: "Organizations" }]}
        title="Organizations"
        description="Tenants on this installation. You see directory figures only, never their business data. Every action here needs a fresh two-step verification."
        actions={<CreateOrganization />}
      />
      <Section>
        {needsMfa ? (
          <EmptyState icon={ShieldCheck} title="Verify it's you to see organizations"
            description="The platform console needs a two-step verification code from the last few minutes."
            action={<Button variant="outline" onClick={() => query.refetch()}>Enter code</Button>} />
        ) : (
          <DataTable columns={columns} rows={query.data} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
            caption="Organizations"
            empty={<EmptyState icon={Building2} title="No organizations yet" description="Create the first one to give a customer their own tenant." />} />
        )}
      </Section>
    </>
  );
}
