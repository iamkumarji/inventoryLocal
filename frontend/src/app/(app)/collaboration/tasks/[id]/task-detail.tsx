"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, UserRoundPlus } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { RecordPanel } from "@/components/collaboration/record-panel";
import { DepartmentSelect, DueLabel, PrioritySelect, TransitionButtons } from "@/components/collaboration/tasks";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import type { Person } from "@/components/erp/person-picker";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionDialog, Facts } from "@/components/production/action-dialog";
import { PersonField } from "@/components/production/pickers";
import { StateBadge } from "@/components/production/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { localToIso, rememberPerson, useOrgPlaces, usePersonLabel, type Task } from "@/lib/api/production";
import { dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { format, parseISO } from "date-fns";

function EditTask({ task, onSaved, onFail }: { task: Task; onSaved: (t: Task) => void; onFail: () => void }) {
  const [open, setOpen] = useState(false);
  const initial = () => ({
    title: task.title, description: task.description, priority: task.priority,
    due_at: task.due_at ? format(parseISO(task.due_at), "yyyy-MM-dd'T'HH:mm") : "", department: task.department ?? "",
  });
  const [form, setForm] = useState(initial);
  const save = useMutation({
    mutationFn: () => unwrap(api.PATCH("/api/v1/collaboration/tasks/{id}/", {
      params: { path: { id: task.id } },
      body: { ...form, due_at: localToIso(form.due_at), department: form.department || null, version: task.version },
    })),
    onSuccess: (t) => { onSaved(t); toast("Task saved"); setOpen(false); },
    onError: onFail,
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  return (
    <ActionDialog open={open} onOpenChange={(next) => { if (next) setForm(initial()); setOpen(next); }} trigger={<Button variant="outline"><Pencil aria-hidden /> Edit</Button>}
      title="Edit task" submitLabel="Save" pending={save.isPending} error={save.error} disabled={!form.title.trim()} onSubmit={() => save.mutate()}>
      <Field id="et-title" label="Title" error={errors.title}><Input id="et-title" className="h-10" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      <Field id="et-description" label="Description" error={errors.description}><Textarea id="et-description" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="et-priority" label="Priority"><PrioritySelect id="et-priority" value={form.priority} onChange={(priority) => setForm({ ...form, priority })} /></Field>
        <Field id="et-due" label="Due" error={errors.due_at}><Input id="et-due" type="datetime-local" className="h-10" value={form.due_at} onChange={(e) => setForm({ ...form, due_at: e.target.value })} /></Field>
      </div>
      <Field id="et-department" label="Department" error={errors.department}><DepartmentSelect id="et-department" value={form.department} onChange={(department) => setForm({ ...form, department })} /></Field>
    </ActionDialog>
  );
}

function AssignTask({ task, onSaved, onFail }: { task: Task; onSaved: (t: Task) => void; onFail: () => void }) {
  const [open, setOpen] = useState(false);
  const [person, setPerson] = useState<Person | null>(null);
  const assign = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/collaboration/tasks/{id}/assign/", { params: { path: { id: task.id } }, body: { assignee: person?.id ?? null, version: task.version } })),
    onSuccess: (t) => {
      rememberPerson(t.assignee ? { id: t.assignee, full_name: t.assignee_name } : null);
      onSaved(t);
      toast(t.assignee ? `Assigned to ${t.assignee_name}` : "Task unassigned");
      setOpen(false);
    },
    onError: onFail,
  });
  return (
    <ActionDialog open={open} onOpenChange={(next) => { if (next) setPerson(null); setOpen(next); }} trigger={<Button variant="outline"><UserRoundPlus aria-hidden /> {task.assignee ? "Reassign" : "Assign"}</Button>}
      title="Assign task" description="The new assignee is notified. Leave empty to unassign." submitLabel={person ? `Assign to ${person.full_name}` : "Unassign"}
      pending={assign.isPending} error={assign.error} disabled={!person && !task.assignee} onSubmit={() => assign.mutate()}>
      <Field id="assign-person" label="Assignee"><PersonField id="assign-person" value={person} onChange={setPerson} /></Field>
    </ActionDialog>
  );
}

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const places = useOrgPlaces();
  const person = usePersonLabel();
  const queryClient = useQueryClient();
  const key = ["collaboration", "task", id];
  const query = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/api/v1/collaboration/tasks/{id}/", { params: { path: { id } } })) });
  const onSaved = (t: Task) => {
    queryClient.setQueryData(key, t);
    queryClient.invalidateQueries({ queryKey: ["collaboration", "tasks"] });
    queryClient.invalidateQueries({ queryKey: ["collaboration", "activity"] });
  };
  const onFail = () => queryClient.invalidateQueries({ queryKey: key });
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const t = query.data!;
  const activeTask = t.status === "open" || t.status === "in_progress";
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Tasks", href: "/collaboration/tasks" }, { label: t.title }]}
        title={t.title}
        meta={<><StateBadge kind="task" value={t.status} /><StateBadge kind="priority" value={t.priority} /><DueLabel task={t} /></>}
        actions={<>
          {activeTask && can("collaboration.task.update") && <EditTask task={t} onSaved={onSaved} onFail={onFail} />}
          {t.status === "open" && can("collaboration.task.assign") && <AssignTask task={t} onSaved={onSaved} onFail={onFail} />}
        </>}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          {can("collaboration.task.update") && (
            <Section title="Status">
              <div className="px-5 py-4"><TransitionButtons task={t} onChanged={onSaved} large /></div>
            </Section>
          )}
          <Section title="Description">
            <p className="px-5 py-4 text-sm whitespace-pre-wrap">{t.description || <span className="text-muted-foreground">No description.</span>}</p>
          </Section>
          <Section title="Details">
            <Facts items={[
              ["Assignee", t.assignee_name || "Unassigned"],
              ["Department", t.department ? places.label(t.department) : "—"],
              ["Created", `${dateTime(t.created_at)} by ${person(t.created_by)}`],
              t.completed_at && ["Completed", dateTime(t.completed_at)],
              t.escalated_at && ["Escalated", `${dateTime(t.escalated_at)} (${t.escalation_count}×)`],
              t.resource_type && ["Linked record", <span key="r" className="num break-all">{t.resource_type} · {t.resource_id}</span>],
            ]} />
          </Section>
        </div>
        <RecordPanel resourceType="collaboration.task" resourceId={t.id} className="min-w-0 self-start" />
      </div>
    </>
  );
}

