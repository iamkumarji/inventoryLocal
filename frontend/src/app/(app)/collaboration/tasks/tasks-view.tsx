"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, ListChecks, Pencil, Plus, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DueLabel, NewTaskDialog } from "@/components/collaboration/tasks";
import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { ActionDialog } from "@/components/production/action-dialog";
import { StateBadge } from "@/components/production/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { humanize, rememberPerson, useOrgPlaces, type EscalationRule, type Task } from "@/lib/api/production";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

const STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
const TARGET_LABEL = { role: "Holders of a role", department_head: "Department head", assignee: "Remind the assignee" } as const;

function TaskList() {
  const { can } = useSession();
  const url = useUrlState();
  const search = url.get("q");
  const status = url.get("status");
  const priority = url.get("priority");
  const [draft, setDraft] = useState(search);
  const query = useQuery({
    queryKey: ["collaboration", "tasks", search, status, priority, url.page],
    queryFn: async () => {
      const data = await unwrap(api.GET("/api/v1/collaboration/tasks/", {
        params: { query: { search: search || undefined, status: (status || undefined) as Task["status"] | undefined, priority: (priority || undefined) as Task["priority"] | undefined, page: url.page } },
      }));
      data.results.forEach((t) => t.assignee && rememberPerson({ id: t.assignee, full_name: t.assignee_name }));
      return data;
    },
  });
  const columns: Column<Task>[] = [
    { key: "title", header: "Task", cell: (t) => <span className="block max-w-[40ch]"><span className="block truncate">{t.title}</span>{t.escalation_count > 0 && <span className="block text-xs font-normal text-status-pending">Escalated {t.escalation_count}×</span>}</span> },
    { key: "status", header: "Status", cell: (t) => <StateBadge kind="task" value={t.status} /> },
    { key: "priority", header: "Priority", className: "hidden sm:table-cell", cell: (t) => <StateBadge kind="priority" value={t.priority} /> },
    { key: "assignee", header: "Assignee", className: "hidden md:table-cell", cell: (t) => t.assignee_name || <span className="text-muted-foreground">Unassigned</span> },
    { key: "due", header: "Due", className: "hidden lg:table-cell", cell: (t) => <DueLabel task={t} /> },
  ];
  return (
    <Section actions={
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <form onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }} className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Search titles" className="h-9 w-full pl-8 sm:w-48" aria-label="Search tasks" />
        </form>
        <Select value={status || "any"} onValueChange={(v) => url.set({ status: v === "any" ? null : v })}>
          <SelectTrigger className="w-32" aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="any">Any status</SelectItem>{STATUSES.map((s) => <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={priority || "any"} onValueChange={(v) => url.set({ priority: v === "any" ? null : v })}>
          <SelectTrigger className="w-32" aria-label="Priority"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="any">Any priority</SelectItem>{(["low", "normal", "high", "urgent"] as const).map((p) => <SelectItem key={p} value={p}>{humanize(p)}</SelectItem>)}</SelectContent>
        </Select>
        {can("collaboration.task.create") && <NewTaskDialog trigger={<Button><Plus aria-hidden /> New task</Button>} />}
      </div>
    }>
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
        rowHref={(t) => `/collaboration/tasks/${t.id}`} empty={<EmptyState icon={ListChecks} title={search || status || priority ? "No task matches" : "No tasks yet"} />} />
      {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
    </Section>
  );
}

type RuleForm = { code: string; name: string; overdue_hours: string; target: EscalationRule["target"]; role: string; priority: string; is_active: boolean };
type PatchedRule = components["schemas"]["PatchedEscalationRuleRequest"];

function RuleDialog({ existing, open, onOpenChange }: { existing: EscalationRule | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const { companyId } = useOrgPlaces();
  const canRoles = can("authorization.role.read");
  const blank: RuleForm = { code: "", name: "", overdue_hours: "24", target: "assignee", role: "", priority: "", is_active: true };
  const [form, setForm] = useState<RuleForm>(blank);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const marker = open ? (existing?.id ?? null) : undefined;
  if (marker !== loadedFor) {
    setLoadedFor(marker);
    if (open) setForm(existing ? { code: existing.code, name: existing.name, overdue_hours: String(existing.overdue_hours), target: existing.target, role: existing.role ?? "", priority: existing.priority ?? "", is_active: existing.is_active ?? true } : blank);
  }
  const roles = useQuery({
    queryKey: ["authorization", "roles", "all"],
    queryFn: () => unwrap(api.GET("/api/v1/authorization/roles/", { params: { query: { page_size: 200 } } })),
    enabled: open && canRoles,
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name, overdue_hours: Number(form.overdue_hours), target: form.target, role: form.target === "role" ? form.role : null,
        priority: form.priority as Task["priority"] | "", is_active: form.is_active,
      };
      return existing
        ? unwrap(api.PATCH("/api/v1/collaboration/escalation-rules/{id}/", { params: { path: { id: existing.id } }, body: { ...body, version: existing.version } as PatchedRule }))
        : unwrap(api.POST("/api/v1/collaboration/escalation-rules/", { body: { ...body, code: form.code, company: companyId } }));
    },
    onSuccess: (rule) => {
      queryClient.invalidateQueries({ queryKey: ["collaboration", "escalation-rules"] });
      toast(`Rule ${rule.code} saved`);
      onOpenChange(false);
    },
    onError: () => queryClient.invalidateQueries({ queryKey: ["collaboration", "escalation-rules"] }),
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  const valid = form.name && (existing || form.code) && /^\d+$/.test(form.overdue_hours) && (form.target !== "role" || form.role);
  return (
    <ActionDialog open={open} onOpenChange={onOpenChange} title={existing ? `Edit rule ${existing.code}` : "New escalation rule"}
      description="Active tasks overdue by this many hours notify the target. Each rule fires once per task."
      submitLabel={existing ? "Save rule" : "Create rule"} pending={save.isPending} error={save.error} disabled={!valid} onSubmit={() => save.mutate()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="r-code" label="Code" error={errors.code}><Input id="r-code" className="num h-10" value={form.code} disabled={!!existing} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
        <Field id="r-name" label="Name" error={errors.name}><Input id="r-name" className="h-10" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field id="r-hours" label="Overdue by (hours)" error={errors.overdue_hours}><Input id="r-hours" inputMode="numeric" className="num h-10" value={form.overdue_hours} onChange={(e) => setForm({ ...form, overdue_hours: e.target.value })} /></Field>
        <Field id="r-priority" label="Only priority" error={errors.priority}>
          <Select value={form.priority || "all"} onValueChange={(v) => setForm({ ...form, priority: v === "all" ? "" : v })}>
            <SelectTrigger id="r-priority" className="h-10 w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All priorities</SelectItem>{(["low", "normal", "high", "urgent"] as const).map((p) => <SelectItem key={p} value={p}>{humanize(p)}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field id="r-target" label="Notify" error={errors.target}>
          <Select value={form.target} onValueChange={(v) => setForm({ ...form, target: v as RuleForm["target"] })}>
            <SelectTrigger id="r-target" className="h-10 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="assignee">{TARGET_LABEL.assignee}</SelectItem>
              <SelectItem value="department_head">{TARGET_LABEL.department_head}</SelectItem>
              {(canRoles || form.target === "role") && <SelectItem value="role">{TARGET_LABEL.role}</SelectItem>}
            </SelectContent>
          </Select>
        </Field>
        {form.target === "role" && (
          <Field id="r-role" label="Role" error={errors.role}>
            <Select value={form.role} onValueChange={(role) => setForm({ ...form, role })} disabled={!canRoles}>
              <SelectTrigger id="r-role" className="h-10 w-full"><SelectValue placeholder="Choose a role" /></SelectTrigger>
              <SelectContent>{(roles.data?.results ?? []).filter((r) => !r.is_system_template).map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        )}
      </div>
      <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
        <Label htmlFor="r-active" className="font-normal">Active</Label>
        <Switch id="r-active" checked={form.is_active} onCheckedChange={(is_active) => setForm({ ...form, is_active })} />
      </div>
    </ActionDialog>
  );
}

function EscalationRules() {
  const { can } = useSession();
  const [editing, setEditing] = useState<EscalationRule | null>(null);
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["collaboration", "escalation-rules"],
    queryFn: () => unwrap(api.GET("/api/v1/collaboration/escalation-rules/", { params: { query: { page_size: 200 } } })),
  });
  const columns: Column<EscalationRule>[] = [
    { key: "rule", header: "Rule", cell: (r) => <span><span className="block font-medium">{r.name}</span><span className="num block text-xs text-muted-foreground">{r.code}</span></span> },
    { key: "after", header: "Overdue by", align: "right", cell: (r) => <span className="num">{r.overdue_hours} h</span> },
    { key: "target", header: "Notifies", cell: (r) => TARGET_LABEL[r.target] },
    { key: "priority", header: "Priority", className: "hidden sm:table-cell", cell: (r) => (r.priority ? humanize(r.priority) : "All") },
    { key: "active", header: "Status", className: "hidden sm:table-cell", cell: (r) => <ActiveStatus active={r.is_active ?? true} /> },
    ...(can("collaboration.escalation_rule.update") ? [{
      key: "edit", header: <span className="sr-only">Edit</span>, align: "right" as const,
      cell: (r: EscalationRule) => <Button variant="ghost" size="icon" aria-label={`Edit ${r.code}`} onClick={() => { setEditing(r); setOpen(true); }}><Pencil aria-hidden /></Button>,
    }] : []),
  ];
  return (
    <Section title="Escalation rules" description="Checked every few minutes against open and in-progress tasks with a due date."
      actions={can("collaboration.escalation_rule.create") && <Button variant="outline" onClick={() => { setEditing(null); setOpen(true); }}><Plus aria-hidden /> New rule</Button>}>
      <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
        empty={<EmptyState icon={BellRing} title="No escalation rules" description="Without rules, overdue tasks only show as overdue." />} />
      <RuleDialog existing={editing} open={open} onOpenChange={setOpen} />
    </Section>
  );
}

export function TasksView() {
  const { can } = useSession();
  const url = useUrlState();
  const tab = url.get("tab") || "tasks";
  return (
    <>
      <PageHeader title="Tasks" description="Team work items, optionally linked to a business record, with due dates and escalation." />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "tasks" ? null : v, q: null, status: null, priority: null })} className="mb-4">
        <TabsList>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          {can("collaboration.escalation_rule.read") && <TabsTrigger value="rules">Escalation rules</TabsTrigger>}
        </TabsList>
      </Tabs>
      {tab === "rules" ? <EscalationRules /> : <TaskList />}
    </>
  );
}
