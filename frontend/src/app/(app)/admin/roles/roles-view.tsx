"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus, StatusBadge } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type Role = components["schemas"]["Role"];

export function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "r_$1").slice(0, 60);
}

function NewRole() {
  const router = useRouter();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [touched, setTouched] = useState(false);
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/authorization/roles/", { body: { name, code, description, permission_codes: [], mfa_required: false } }))),
    onSuccess: (role) => {
      queryClient.invalidateQueries({ queryKey: ["authorization", "roles"] });
      router.push(`/admin/roles/${role.id}`);
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus aria-hidden /> New role</Button></DialogTrigger>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <DialogHeader>
            <DialogTitle>New role</DialogTitle>
            <DialogDescription>Start empty, then choose permissions. To start from a template, open it and use Clone.</DialogDescription>
          </DialogHeader>
          <FormError message={errors._form} />
          <Field id="name" label="Name" error={errors.name}>
            <Input id="name" value={name} required onChange={(e) => { setName(e.target.value); if (!touched) setCode(slugify(e.target.value)); }} placeholder="Store keeper, Pune plant" />
          </Field>
          <Field id="code" label="Code" error={errors.code} hint="Lowercase letters, numbers and underscores. Can't be changed later.">
            <Input id="code" value={code} required onChange={(e) => { setTouched(true); setCode(e.target.value); }} className="num" />
          </Field>
          <Field id="description" label="What this role is for" error={errors.description}>
            <Textarea id="description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <DialogFooter><Button type="submit" disabled={!name || !code || create.isPending}>Create role</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RolesView() {
  const { can } = useSession();
  const url = useUrlState();
  const kind = url.get("kind");
  const query = useQuery({
    queryKey: ["authorization", "roles", kind, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/authorization/roles/", {
      params: { query: { is_system_template: kind === "templates" ? true : kind === "custom" ? false : undefined, page: url.page } },
    })),
  });
  const columns: Column<Role>[] = [
    { key: "name", header: "Role", cell: (r) => <span><span className="block">{r.name}</span><span className="num block text-xs font-normal text-muted-foreground">{r.code}</span></span> },
    { key: "perms", header: "Permissions", align: "right", cell: (r) => <span className="num">{r.permission_codes.length}</span> },
    { key: "kind", header: "Kind", cell: (r) => r.is_system_template ? <StatusBadge tone="info">Template</StatusBadge> : <StatusBadge tone="neutral">Custom</StatusBadge> },
    { key: "mfa", header: "Two-step", cell: (r) => r.mfa_required ? "Required" : <span className="text-muted-foreground">Optional</span> },
    { key: "status", header: "Status", cell: (r) => <ActiveStatus active={r.is_active} /> },
  ];
  return (
    <>
      <PageHeader title="Roles" description="Bundles of permissions. A role does nothing until it's granted to someone for a scope." actions={can("authorization.role.create") && <NewRole />} />
      <Section actions={
        <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
          {[["", "All"], ["custom", "Custom"], ["templates", "Templates"]].map(([value, label]) => (
            <Button key={value} size="sm" variant={kind === value ? "secondary" : "ghost"} onClick={() => url.set({ kind: value })}>{label}</Button>
          ))}
        </div>
      }>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(r) => `/admin/roles/${r.id}`} empty={<EmptyState icon={KeyRound} title="No roles here" />} />
      </Section>
    </>
  );
}
