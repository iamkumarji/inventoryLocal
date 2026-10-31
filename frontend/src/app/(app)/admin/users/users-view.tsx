"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { ago } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type User = components["schemas"]["User"];

export function UserState({ user }: { user: User }) {
  if (!user.is_active) return <StatusBadge tone="neutral">Deactivated</StatusBadge>;
  if (user.is_locked) return <StatusBadge tone="rejected">Locked</StatusBadge>;
  if (user.must_change_password) return <StatusBadge tone="info">Invited</StatusBadge>;
  return <StatusBadge tone="approved">Active</StatusBadge>;
}

function temporaryPassword(): string {
  const words = ["lathe", "anvil", "rivet", "gauge", "spindle", "boiler", "forge", "valve", "pallet", "gasket", "turbine", "crane"];
  const bytes = crypto.getRandomValues(new Uint32Array(4));
  return `${words[bytes[0] % words.length]}-${words[bytes[1] % words.length]}-${words[bytes[2] % words.length]}-${(bytes[3] % 900) + 100}`;
}

function NewUser() {
  const { me } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: "", full_name: "", phone: "", default_company: me.active_company_id ?? "", mfa_enforced: true });
  const [password, setPassword] = useState(temporaryPassword);
  const create = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/api/v1/identity/users/", {
        params: { header: { "Idempotency-Key": idempotencyKey() } },
        body: { ...form, default_company: form.default_company || null, temporary_password: password },
      })),
    onSuccess: (user) => {
      queryClient.invalidateQueries({ queryKey: ["identity", "users"] });
      toast(`${user.full_name} added. Share the temporary password through a separate channel.`);
      router.push(`/admin/users/${user.id}`);
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus aria-hidden /> Add user</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Add a user</DialogTitle>
            <DialogDescription>They sign in with the temporary password and must replace it. Grant access separately under Access grants.</DialogDescription>
          </DialogHeader>
          <FormError message={create.error && !isApiError(create.error, "validation_error") ? (isApiError(create.error) ? create.error.summary() : "Couldn't reach the server.") : undefined} />
          <Field id="full_name" label="Full name" error={errors.full_name}><Input id="full_name" value={form.full_name} onChange={set("full_name")} required /></Field>
          <Field id="email" label="Work email" error={errors.email}><Input id="email" type="email" value={form.email} onChange={set("email")} required /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="phone" label="Phone" error={errors.phone}><Input id="phone" value={form.phone} onChange={set("phone")} /></Field>
            <Field id="default_company" label="Default company" error={errors.default_company}>
              <Select value={form.default_company} onValueChange={(v) => setForm({ ...form, default_company: v })}>
                <SelectTrigger id="default_company" className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
                <SelectContent>{me.companies.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
          <Field id="temporary_password" label="Temporary password" error={errors.temporary_password}>
            <div className="flex gap-2">
              <Input id="temporary_password" value={password} onChange={(e) => setPassword(e.target.value)} className="num" required />
              <Button type="button" variant="outline" onClick={() => setPassword(temporaryPassword())}>New</Button>
            </div>
          </Field>
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
            <Label htmlFor="mfa_enforced" className="font-normal">Require two-step verification</Label>
            <Switch id="mfa_enforced" checked={form.mfa_enforced} onCheckedChange={(v) => setForm({ ...form, mfa_enforced: v })} />
          </div>
          <DialogFooter><Button type="submit" disabled={create.isPending}>Add user</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function UsersView() {
  const { can, me } = useSession();
  const url = useUrlState();
  const search = url.get("q");
  const [draft, setDraft] = useState(search);
  const status = url.get("status");
  const query = useQuery({
    queryKey: ["identity", "users", search, status, url.page],
    queryFn: () =>
      unwrap(api.GET("/api/v1/identity/users/", {
        params: { query: { search: search || undefined, is_active: status === "" ? undefined : status === "active", page: url.page } },
      })),
  });
  const companyName = (id: string | null) => me.companies.find((c) => c.id === id)?.name ?? "—";
  const columns: Column<User>[] = [
    { key: "name", header: "Name", cell: (u) => <span><span className="block">{u.full_name}</span><span className="block text-xs font-normal text-muted-foreground">{u.email}</span></span> },
    { key: "company", header: "Default company", cell: (u) => companyName(u.default_company) },
    { key: "mfa", header: "Two-step", cell: (u) => u.mfa_enrolled ? <StatusBadge tone="approved">On</StatusBadge> : u.mfa_enforced ? <StatusBadge tone="pending">Required, not set up</StatusBadge> : <StatusBadge tone="neutral">Off</StatusBadge> },
    { key: "state", header: "Status", cell: (u) => <UserState user={u} /> },
    { key: "last", header: "Last sign-in", cell: (u) => <span className="text-muted-foreground">{u.last_login ? ago(u.last_login) : "Never"}</span> },
  ];
  return (
    <>
      <PageHeader title="Users" description="People who can sign in. What they can do comes from their access grants." actions={can("identity.user.create") && <NewUser />} />
      <Section
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <form onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }} className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Name, email or phone" className="h-9 w-56 pl-8" aria-label="Search users" />
            </form>
            <Select value={status || "any"} onValueChange={(v) => url.set({ status: v === "any" ? null : v })}>
              <SelectTrigger className="w-36" aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Deactivated</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(u) => `/admin/users/${u.id}`} empty={<EmptyState icon={Users} title="No users match" />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
