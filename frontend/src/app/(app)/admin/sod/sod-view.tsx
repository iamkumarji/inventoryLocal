"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Split } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus, StatusBadge } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { usePermissionCatalog } from "@/lib/api/hooks";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { useSession } from "@/lib/session";

type Rule = components["schemas"]["SodRule"];
type Mode = Rule["mode"];
const MODE_LABEL: Record<string, string> = {
  same_user_same_record: "Not on the same record (maker-checker)",
  same_user_any: "Never held by the same person",
};

function NewRule() {
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const catalog = usePermissionCatalog();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: "", description: "", permission_a: "", permission_b: "", mode: "same_user_same_record" as Mode });
  const create = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/authorization/sod-rules/", { body: form }))),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["authorization", "sod"] }); toast("Rule added"); setOpen(false); },
  });
  const perms = catalog.data ?? [];
  const select = (key: "permission_a" | "permission_b", label: string) => (
    <Field id={key} label={label}>
      <Select value={form[key]} onValueChange={(v) => setForm({ ...form, [key]: v })}>
        <SelectTrigger id={key} className="w-full"><SelectValue placeholder="Choose a permission" /></SelectTrigger>
        <SelectContent>{perms.map((p) => <SelectItem key={p.code} value={p.code}><span className="num text-xs">{p.code}</span></SelectItem>)}</SelectContent>
      </Select>
    </Field>
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus aria-hidden /> Add rule</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <DialogHeader><DialogTitle>Add a segregation-of-duties rule</DialogTitle>
            <DialogDescription>Stops one person from both doing and checking the same work.</DialogDescription></DialogHeader>
          <FormError message={create.error ? (isApiError(create.error) ? create.error.summary() : "Couldn't reach the server.") : undefined} />
          <Field id="code" label="Code"><Input id="code" className="num" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></Field>
          {select("permission_a", "Doing this")}
          {select("permission_b", "conflicts with doing this")}
          <Field id="mode" label="How strictly">
            <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as Mode })}>
              <SelectTrigger id="mode" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(MODE_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="description" label="Why"><Input id="description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <DialogFooter><Button type="submit" disabled={!form.code || !form.permission_a || !form.permission_b || create.isPending}>Add rule</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SodView() {
  const { can } = useSession();
  const rules = useQuery({ queryKey: ["authorization", "sod", "rules"], queryFn: () => unwrap(api.GET("/api/v1/authorization/sod-rules/", { params: { query: { page_size: 200 } } })) });
  const conflicts = useQuery({ queryKey: ["authorization", "sod", "conflicts"], queryFn: () => unwrap(api.GET("/api/v1/authorization/sod-rules/conflicts/")) });
  const columns: Column<Rule>[] = [
    { key: "code", header: "Rule", cell: (r) => <span><span className="num block">{r.code}</span><span className="block text-xs text-muted-foreground">{r.description}</span></span> },
    { key: "pair", header: "Conflicting permissions", cell: (r) => <span className="num text-xs">{r.permission_a}<br />{r.permission_b}</span> },
    { key: "mode", header: "Strictness", cell: (r) => MODE_LABEL[r.mode] },
    { key: "status", header: "Status", cell: (r) => <ActiveStatus active={r.is_active} /> },
  ];
  type Conflict = { user_id: string; rule: string; permission_a?: string; permission_b?: string; id?: string };
  const conflictRows = ((conflicts.data ?? []) as Conflict[]).map((c, i) => ({ ...c, id: `${c.user_id}-${c.rule}-${i}` }));
  return (
    <>
      <PageHeader title="Segregation of duties" description="Pairs of duties that one person shouldn't hold together. Self-approval is always blocked, separately from these rules."
        actions={can("authorization.sod_rule.manage") && <NewRule />} />
      <div className="grid gap-6">
        <Section title="People with conflicting duties right now" description="Found by checking current grants against “never held by the same person” rules.">
          <DataTable rows={conflictRows} isLoading={conflicts.isLoading} error={conflicts.error}
            columns={[
              { key: "user", header: "Person", cell: (c) => <Link href={`/admin/users/${c.user_id}`} className="hover:underline">Open user</Link> },
              { key: "rule", header: "Rule", cell: (c) => <span className="num">{c.rule}</span> },
              { key: "detail", header: "Holds both", cell: (c) => <span className="num text-xs">{c.permission_a} + {c.permission_b}</span> },
              { key: "state", header: "", cell: () => <StatusBadge tone="rejected">Conflict</StatusBadge> },
            ]}
            empty={<EmptyState title="No conflicts" description="Nobody currently holds a forbidden combination." />} />
        </Section>
        <Section title="Rules">
          <DataTable columns={columns} rows={rules.data?.results} isLoading={rules.isLoading} error={rules.error} onRetry={rules.refetch}
            empty={<EmptyState icon={Split} title="No rules yet" description="Rule templates for purchasing, payments and stock counts are added when those modules are enabled." />} />
        </Section>
      </div>
    </>
  );
}
