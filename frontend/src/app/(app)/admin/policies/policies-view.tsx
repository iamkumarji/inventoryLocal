"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus, StatusBadge } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { useSession } from "@/lib/session";

type Policy = components["schemas"]["Policy"];
type Draft = { code: string; description: string; effect: "allow" | "deny"; priority: number; actions: string; resource_types: string; condition: string; is_active: boolean };

const EMPTY: Draft = {
  code: "", description: "", effect: "deny", priority: 100, actions: "", resource_types: "", is_active: false,
  condition: JSON.stringify({ attr: "env.ip_internal", op: "eq", value: false }, null, 2),
};
const lines = (value: string) => value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

function PolicyEditor({ policy, open, onOpenChange }: { policy: Policy | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [lastPolicy, setLastPolicy] = useState<Policy | null | undefined>(undefined);
  if (open && lastPolicy !== policy) {
    setLastPolicy(policy);
    setProblems(null);
    setDraft(policy ? {
      code: policy.code, description: policy.description ?? "", effect: policy.effect, priority: policy.priority ?? 100,
      actions: (policy.actions ?? []).join("\n"), resource_types: (policy.resource_types ?? []).join("\n"),
      condition: JSON.stringify(policy.condition ?? {}, null, 2), is_active: policy.is_active ?? false,
    } : EMPTY);
  }
  const parsed = (() => { try { return { ok: true as const, value: JSON.parse(draft.condition || "{}") }; } catch { return { ok: false as const, value: null }; } })();
  const payload = () => ({
    code: draft.code, description: draft.description, effect: draft.effect, priority: draft.priority,
    actions: lines(draft.actions), resource_types: lines(draft.resource_types), condition: parsed.value, is_active: draft.is_active,
  });
  const check = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/authorization/policies/validate/", { body: payload() })),
    onSuccess: (r) => setProblems(r.errors as string[]),
  });
  const save = useMutation({
    mutationFn: () => withStepUp(() => policy
      ? unwrap(api.PATCH("/api/v1/authorization/policies/{id}/", { params: { path: { id: policy.id } }, body: { ...payload(), version: policy.version } }))
      : unwrap(api.POST("/api/v1/authorization/policies/", { body: payload() }))),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["authorization", "policies"] }); toast("Policy saved"); onOpenChange(false); },
  });
  const saveErrors = isApiError(save.error) ? save.error.problem.errors?.map((e) => e.message) ?? [save.error.summary()] : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{policy ? `Edit ${policy.code}` : "New policy"}</SheetTitle>
          <SheetDescription>Deny policies override any role. Allow policies grant narrow, conditional access such as “own records”.</SheetDescription>
        </SheetHeader>
        <form className="grid gap-4 px-4 pb-6" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          {saveErrors.length > 0 && <FormError message={saveErrors.join(" ")} />}
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem_6rem]">
            <Field id="p-code" label="Code"><Input id="p-code" value={draft.code} disabled={!!policy} onChange={(e) => setDraft({ ...draft, code: e.target.value })} className="num" required /></Field>
            <Field id="p-effect" label="Effect">
              <Select value={draft.effect} onValueChange={(v) => setDraft({ ...draft, effect: v as Draft["effect"] })}>
                <SelectTrigger id="p-effect" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="deny">Deny</SelectItem><SelectItem value="allow">Allow</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field id="p-priority" label="Priority"><Input id="p-priority" type="number" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} /></Field>
          </div>
          <Field id="p-desc" label="What it does"><Input id="p-desc" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
          <Field id="p-actions" label="Actions" hint="One per line, as module.resource.action. Use * as a wildcard, e.g. *.*.export">
            <Textarea id="p-actions" rows={3} value={draft.actions} onChange={(e) => setDraft({ ...draft, actions: e.target.value })} className="num text-[0.8rem]" />
          </Field>
          <Field id="p-types" label="Resource types" hint="Optional. Limits the policy to these resources, e.g. hr.payslip">
            <Textarea id="p-types" rows={2} value={draft.resource_types} onChange={(e) => setDraft({ ...draft, resource_types: e.target.value })} className="num text-[0.8rem]" />
          </Field>
          <Field id="p-cond" label="Condition" error={parsed.ok ? undefined : "This isn't valid JSON."}
            hint="Attributes: subject.*, resource.*, env.* (time, weekday, ip_internal, client_type), action.*">
            <Textarea id="p-cond" rows={9} value={draft.condition} onChange={(e) => { setDraft({ ...draft, condition: e.target.value }); setProblems(null); }} className="num text-[0.8rem]" spellCheck={false} />
          </Field>
          {problems && (problems.length === 0
            ? <p className="text-sm text-status-approved">The policy is valid.</p>
            : <ul className="list-disc pl-5 text-sm text-status-rejected">{problems.map((p) => <li key={p}>{p}</li>)}</ul>)}
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
            <Label htmlFor="p-active" className="font-normal">Active</Label>
            <Switch id="p-active" checked={draft.is_active} onCheckedChange={(v) => setDraft({ ...draft, is_active: v })} />
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => check.mutate()} disabled={!parsed.ok || check.isPending}>Check</Button>
            <Button type="submit" disabled={!parsed.ok || save.isPending}>Save policy</Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function PoliciesView() {
  const { can } = useSession();
  const [editing, setEditing] = useState<Policy | null>(null);
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ["authorization", "policies"], queryFn: () => unwrap(api.GET("/api/v1/authorization/policies/", { params: { query: { page_size: 200 } } })) });
  const manage = can("authorization.policy.manage");
  const columns: Column<Policy>[] = [
    { key: "code", header: "Policy", cell: (p) => <button type="button" className="text-left font-medium hover:underline disabled:no-underline" disabled={!manage} onClick={() => { setEditing(p); setOpen(true); }}>
      <span className="num block">{p.code}</span><span className="block text-xs font-normal text-muted-foreground">{p.description}</span></button> },
    { key: "effect", header: "Effect", cell: (p) => p.effect === "deny" ? <StatusBadge tone="rejected">Deny</StatusBadge> : <StatusBadge tone="info">Allow</StatusBadge> },
    { key: "actions", header: "Applies to", cell: (p) => <span className="num text-xs">{(p.actions ?? []).join(", ")}</span> },
    { key: "status", header: "Status", cell: (p) => <span className="flex gap-1.5"><ActiveStatus active={!!p.is_active} />{p.is_template && <StatusBadge tone="neutral">Template</StatusBadge>}</span> },
  ];
  return (
    <>
      <PageHeader title="Policies" description="Rules on top of roles that use context: time of day, network, device, ownership, amounts."
        actions={manage && <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus aria-hidden /> New policy</Button>} />
      <Section>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          empty={<EmptyState icon={ShieldCheck} title="No policies" description="Without policies, access comes from roles alone." />} />
      </Section>
      <PolicyEditor policy={editing} open={open} onOpenChange={setOpen} />
    </>
  );
}
