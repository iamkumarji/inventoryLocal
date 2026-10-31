"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, CheckCheck, CircleSlash, Play, RotateCcw, Undo2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/erp/field";
import type { Person } from "@/components/erp/person-picker";
import { ActionDialog } from "@/components/production/action-dialog";
import { PersonField } from "@/components/production/pickers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { localToIso, problemMessage, rememberPerson, useOrgPlaces, type Task } from "@/lib/api/production";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type TaskStatus = Task["status"];
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

/** Allowed moves (apps/collaboration/services.py TRANSITIONS). */
const MOVES: Record<TaskStatus, Array<{ to: TaskStatus; label: string; icon: LucideIcon; primary?: boolean }>> = {
  open: [
    { to: "in_progress", label: "Start", icon: Play, primary: true },
    { to: "done", label: "Mark done", icon: CheckCheck },
    { to: "cancelled", label: "Cancel task", icon: CircleSlash },
  ],
  in_progress: [
    { to: "done", label: "Mark done", icon: CheckCheck, primary: true },
    { to: "open", label: "Back to open", icon: Undo2 },
    { to: "cancelled", label: "Cancel task", icon: CircleSlash },
  ],
  done: [{ to: "open", label: "Reopen", icon: RotateCcw }],
  cancelled: [{ to: "open", label: "Reopen", icon: RotateCcw }],
};

const DONE_MESSAGE: Record<TaskStatus, string> = { open: "Task reopened", in_progress: "Task started", done: "Task done", cancelled: "Task cancelled" };

export function isOverdue(task: Task): boolean {
  return !!task.due_at && (task.status === "open" || task.status === "in_progress") && new Date(task.due_at).getTime() < Date.now();
}

export function DueLabel({ task }: { task: Task }) {
  if (!task.due_at) return <span className="text-muted-foreground">No due date</span>;
  const overdue = isOverdue(task);
  return (
    <span className={cn("inline-flex items-center gap-1", overdue ? "font-medium text-status-rejected" : "text-muted-foreground")}>
      {overdue && <AlarmClock className="size-3.5" aria-hidden />}
      {overdue ? "Overdue " : "Due "}{dateTime(task.due_at)}
    </span>
  );
}

/** Status buttons for a task. `self` uses the self-service endpoint (My tasks). */
export function TransitionButtons({ task, self, onChanged, large }: { task: Task; self?: boolean; onChanged: (task: Task) => void; large?: boolean }) {
  const queryClient = useQueryClient();
  const move = useMutation({
    mutationFn: (to: TaskStatus) => {
      const body = { status: to, version: task.version };
      const path = { params: { path: { id: task.id } }, body };
      return unwrap(self ? api.POST("/api/v1/collaboration/my-tasks/{id}/transition/", path) : api.POST("/api/v1/collaboration/tasks/{id}/transition/", path));
    },
    onSuccess: (fresh, to) => {
      onChanged(fresh);
      queryClient.invalidateQueries({ queryKey: ["collaboration", "tasks"] });
      queryClient.invalidateQueries({ queryKey: ["collaboration", "my-tasks"] });
      toast(DONE_MESSAGE[to]);
    },
    onError: (error) => {
      toast.error(problemMessage(error));
      queryClient.invalidateQueries({ queryKey: ["collaboration"] });
    },
  });
  return (
    <div className="flex flex-wrap gap-2">
      {MOVES[task.status].map((m) => (
        <Button key={m.to} variant={m.primary ? "default" : "outline"} size={large ? "lg" : "sm"} className={large ? "h-11" : undefined}
          disabled={move.isPending} onClick={() => move.mutate(m.to)} aria-label={`${m.label}: ${task.title}`}>
          <m.icon aria-hidden /> {m.label}
        </Button>
      ))}
    </div>
  );
}

export function DepartmentSelect({ id, value, onChange }: { id: string; value: string; onChange: (id: string) => void }) {
  const { departments } = useOrgPlaces();
  return (
    <Select value={value || "none"} onValueChange={(v) => onChange(v === "none" ? "" : v)}>
      <SelectTrigger id={id} className="h-10 w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="none">No department</SelectItem>
        {departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function PrioritySelect({ id, value, onChange }: { id: string; value: string; onChange: (v: Task["priority"]) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Task["priority"])}>
      <SelectTrigger id={id} className="h-10 w-full"><SelectValue /></SelectTrigger>
      <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</SelectItem>)}</SelectContent>
    </Select>
  );
}

export function NewTaskDialog({ trigger, resource }: { trigger: React.ReactNode; resource?: { type: string; id: string } }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { companyId } = useOrgPlaces();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", priority: "normal" as Task["priority"], due_at: "", department: "" });
  const [assignee, setAssignee] = useState<Person | null>(null);
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/collaboration/tasks/", {
      body: {
        company: companyId, title: form.title, description: form.description, priority: form.priority,
        due_at: localToIso(form.due_at), assignee: assignee?.id ?? null, department: form.department || null,
        resource_type: resource?.type ?? "", resource_id: resource?.id ?? "",
      },
    })),
    onSuccess: (task) => {
      rememberPerson(task.assignee ? { id: task.assignee, full_name: task.assignee_name } : null);
      queryClient.invalidateQueries({ queryKey: ["collaboration", "tasks"] });
      toast(task.assignee ? `Task assigned to ${task.assignee_name}` : "Task created");
      setOpen(false);
      router.push(`/collaboration/tasks/${task.id}`);
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  return (
    <ActionDialog open={open} onOpenChange={setOpen} trigger={trigger} title="New task" description="Assignees are notified. Overdue tasks escalate by the company's escalation rules."
      submitLabel="Create task" pending={create.isPending} error={create.error} disabled={!form.title.trim()} onSubmit={() => create.mutate()}>
      <Field id="t-title" label="Title" error={errors.title}><Input id="t-title" className="h-10" maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      <Field id="t-description" label="Description" error={errors.description}><Textarea id="t-description" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="t-priority" label="Priority" error={errors.priority}><PrioritySelect id="t-priority" value={form.priority} onChange={(priority) => setForm({ ...form, priority })} /></Field>
        <Field id="t-due" label="Due" error={errors.due_at}><Input id="t-due" type="datetime-local" className="h-10" value={form.due_at} onChange={(e) => setForm({ ...form, due_at: e.target.value })} /></Field>
      </div>
      <Field id="t-assignee" label="Assignee" error={errors.assignee}><PersonField id="t-assignee" value={assignee} onChange={setAssignee} placeholder="Unassigned" /></Field>
      <Field id="t-department" label="Department" error={errors.department} hint="Department-scoped access and department-head escalation use this.">
        <DepartmentSelect id="t-department" value={form.department} onChange={(department) => setForm({ ...form, department })} />
      </Field>
    </ActionDialog>
  );
}
