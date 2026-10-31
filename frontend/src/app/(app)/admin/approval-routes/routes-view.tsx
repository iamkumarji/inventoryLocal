"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, unwrap } from "@/lib/api/client";
import { useRoles } from "@/lib/api/hooks";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";

type Matrix = components["schemas"]["Matrix"];
type LevelDraft = { sequence: number; name: string; role: string; min_amount: string; escalation_hours: string; escalation_role: string };
const ALL = "__all__";
const NONE = "__none__";

function RouteEditor({ matrix, open, onOpenChange }: { matrix: Matrix | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { me } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const roles = useRoles();
  const types = useQuery({ queryKey: ["approvals", "types"], queryFn: () => unwrap(api.GET("/api/v1/approvals/document-types/")) });
  const [seen, setSeen] = useState<Matrix | null | undefined>(undefined);
  const [form, setForm] = useState({ name: "", document_type: "", company: ALL });
  const [levels, setLevels] = useState<LevelDraft[]>([]);
  if (open && seen !== matrix) {
    setSeen(matrix);
    setForm({ name: matrix?.name ?? "", document_type: matrix?.document_type ?? "", company: matrix?.company ?? ALL });
    setLevels(matrix ? matrix.levels.map((l) => ({
      sequence: l.sequence, name: l.name, role: l.role, min_amount: l.min_amount ?? "0",
      escalation_hours: l.escalation_hours ? String(l.escalation_hours) : "", escalation_role: l.escalation_role ?? NONE,
    })) : [{ sequence: 1, name: "", role: "", min_amount: "0", escalation_hours: "", escalation_role: NONE }]);
  }
  const body = () => ({
    name: form.name,
    levels: levels.map((l, i) => ({
      sequence: i + 1, name: l.name, role: l.role, min_amount: l.min_amount || "0", condition: {},
      escalation_hours: l.escalation_hours ? Number(l.escalation_hours) : null,
      escalation_role: l.escalation_role === NONE ? null : l.escalation_role,
    })),
  });
  const save = useMutation({
    mutationFn: () => withStepUp(() => matrix
      ? unwrap(api.PATCH("/api/v1/approvals/matrices/{id}/", { params: { path: { id: matrix.id } }, body: { ...body(), version: matrix.version } }))
      : unwrap(api.POST("/api/v1/approvals/matrices/", { body: { ...body(), document_type: form.document_type, company: form.company === ALL ? null : form.company } }))),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["approvals", "matrices"] }); toast("Approval route saved"); onOpenChange(false); },
  });
  const update = (index: number, patch: Partial<LevelDraft>) => setLevels(levels.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const roleList = roles.data?.results ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{matrix ? `Edit ${matrix.name}` : "New approval route"}</SheetTitle>
          <SheetDescription>A request needs every step whose starting amount it reaches, in order. Changes apply to new requests only.</SheetDescription>
        </SheetHeader>
        <form className="grid gap-5 px-4 pb-6" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          {save.error && <FormError message={isApiError(save.error) ? save.error.summary() : "Couldn't reach the server."} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="r-name" label="Route name"><Input id="r-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
            <Field id="r-doc" label="Document">
              <Select value={form.document_type} disabled={!!matrix} onValueChange={(v) => setForm({ ...form, document_type: v })}>
                <SelectTrigger id="r-doc" className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
                <SelectContent>{types.data?.map((t) => <SelectItem key={t.code} value={t.code}>{t.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field id="r-company" label="Company">
              <Select value={form.company} disabled={!!matrix} onValueChange={(v) => setForm({ ...form, company: v })}>
                <SelectTrigger id="r-company" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={ALL}>Every company (default route)</SelectItem>
                  {me.companies.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-3">
            <p className="type-section">Steps</p>
            <ol className="grid gap-3">
              {levels.map((level, index) => (
                <li key={index} className="grid gap-3 rounded-lg border p-4">
                  <div className="flex items-center justify-between">
                    <span className="num text-sm font-semibold">Step {index + 1}</span>
                    {levels.length > 1 && <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove step ${index + 1}`} onClick={() => setLevels(levels.filter((_, i) => i !== index))}><Trash2 /></Button>}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id={`l-name-${index}`} label="Step name"><Input id={`l-name-${index}`} value={level.name} onChange={(e) => update(index, { name: e.target.value })} placeholder="Department manager" required /></Field>
                    <Field id={`l-role-${index}`} label="Approver role">
                      <Select value={level.role} onValueChange={(v) => update(index, { role: v })}>
                        <SelectTrigger id={`l-role-${index}`} className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
                        <SelectContent>{roleList.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                    <Field id={`l-min-${index}`} label="Needed from amount" hint="0 means every request">
                      <Input id={`l-min-${index}`} inputMode="decimal" className="num" value={level.min_amount} onChange={(e) => update(index, { min_amount: e.target.value })} />
                    </Field>
                    <Field id={`l-esc-${index}`} label="Escalate after (hours)">
                      <Input id={`l-esc-${index}`} inputMode="numeric" className="num" value={level.escalation_hours} onChange={(e) => update(index, { escalation_hours: e.target.value })} />
                    </Field>
                    <Field id={`l-escrole-${index}`} label="Escalate to role" className="sm:col-span-2">
                      <Select value={level.escalation_role} onValueChange={(v) => update(index, { escalation_role: v })}>
                        <SelectTrigger id={`l-escrole-${index}`} className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value={NONE}>No escalation role (remind approvers only)</SelectItem>
                          {roleList.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                  </div>
                </li>
              ))}
            </ol>
            <Button type="button" variant="outline" className="justify-self-start" onClick={() => setLevels([...levels, { sequence: levels.length + 1, name: "", role: "", min_amount: "0", escalation_hours: "", escalation_role: NONE }])}>
              <Plus aria-hidden /> Add step
            </Button>
          </div>
          <Button type="submit" disabled={save.isPending || !form.name || !form.document_type || levels.some((l) => !l.name || !l.role)}>Save route</Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function RoutesView() {
  const { can, me } = useSession();
  const [editing, setEditing] = useState<Matrix | null>(null);
  const [open, setOpen] = useState(false);
  const types = useQuery({ queryKey: ["approvals", "types"], queryFn: () => unwrap(api.GET("/api/v1/approvals/document-types/")) });
  const query = useQuery({ queryKey: ["approvals", "matrices"], queryFn: () => unwrap(api.GET("/api/v1/approvals/matrices/", { params: { query: { page_size: 200 } } })) });
  const manage = can("approvals.approval_matrix.manage");
  const label = (code: string) => types.data?.find((t) => t.code === code)?.label ?? code;
  const noTypes = types.data && types.data.length === 0;

  return (
    <>
      <PageHeader title="Approval routes" description="Who approves each kind of document, in which order, from which amount."
        actions={manage && <Button disabled={noTypes} onClick={() => { setEditing(null); setOpen(true); }}><Plus aria-hidden /> New route</Button>} />
      {query.isLoading ? <RowsSkeleton /> : query.error ? <ErrorState error={query.error} onRetry={query.refetch} /> : query.data!.results.length === 0 ? (
        <Section>
          <EmptyState icon={GitBranch} title="No approval routes yet"
            description={noTypes ? "No document types can be routed yet. Purchase requisitions, purchase orders, payments and expense claims become available as those modules are enabled." : "Create a route so requests know who approves them."} />
        </Section>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {query.data!.results.map((m) => (
            <Section key={m.id} title={m.name} description={`${label(m.document_type)}, ${m.company ? me.companies.find((c) => c.id === m.company)?.name ?? "one company" : "every company"}`}
              actions={<div className="flex items-center gap-2"><ActiveStatus active={m.is_active ?? true} />{manage && <Button size="sm" variant="outline" onClick={() => { setEditing(m); setOpen(true); }}>Edit</Button>}</div>}>
              <ol className="divide-y">
                {m.levels.map((l) => (
                  <li key={l.id} className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-baseline gap-3 px-5 py-2.5 text-sm">
                    <span className="num font-semibold text-muted-foreground">{l.sequence}</span>
                    <span><span className="font-medium">{l.name}</span> <span className="text-muted-foreground">({l.role_code})</span></span>
                    <span className="num text-muted-foreground">{Number(l.min_amount) > 0 ? `from ${money(l.min_amount)}` : "always"}</span>
                  </li>
                ))}
              </ol>
            </Section>
          ))}
        </div>
      )}
      <RouteEditor matrix={editing} open={open} onOpenChange={setOpen} />
    </>
  );
}
