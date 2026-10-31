"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/erp/field";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { DocStatus } from "@/components/people/amount";
import { CancelLeave, canCancelLeave } from "@/components/people/leave-actions";
import { Card, SelfService } from "@/components/people/self-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { compareDecimal, errorText, today, trimDecimal, useLeaveTypes, type LeaveBalance } from "@/lib/api/people";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

/** Calendar days, both ends included (the server computes the same). */
function daysBetween(from: string, to: string): number {
  if (!from || !to || to < from) return 0;
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

function useTypeLabel() {
  const { can } = useSession();
  // Leave type names need hr.leave_type.read; without it the screen falls back to a generic label.
  const types = useLeaveTypes(can("hr.leave_type.read"));
  const list = types.data?.results ?? [];
  return { list, name: (id: string) => list.find((t) => t.id === id)?.name ?? "Leave" };
}

function ApplyForm({ balances }: { balances: LeaveBalance[] }) {
  const queryClient = useQueryClient();
  const types = useTypeLabel();
  const year = Number(today().slice(0, 4));
  const options = new Map<string, string>();
  for (const b of balances) options.set(b.leave_type, types.name(b.leave_type));
  for (const t of types.list) if (t.is_active ?? true) options.set(t.id, t.name);
  const [form, setForm] = useState({ leave_type: "", from_date: today(), to_date: today(), reason: "" });
  const days = daysBetween(form.from_date, form.to_date);
  const balance = balances.find((b) => b.leave_type === form.leave_type && b.year === Number(form.from_date.slice(0, 4)));
  const short = Boolean(balance && compareDecimal(String(days), balance.available) > 0);
  const apply = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/hr/my/leave-requests/", { body: { ...form, submit: true } })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", "my"] });
      setForm({ leave_type: "", from_date: today(), to_date: today(), reason: "" });
      toast("Leave requested. You'll be notified when it's decided.");
    },
  });
  const errors = isApiError(apply.error) ? apply.error.fieldErrors() : {};
  return (
    <Card>
      <form className="grid gap-4 p-4 sm:p-5" onSubmit={(e) => { e.preventDefault(); apply.mutate(); }}>
        <h2 className="type-section flex items-center gap-2"><CalendarPlus className="size-4" aria-hidden /> Apply for leave</h2>
        <FormError message={apply.error && !isApiError(apply.error, "validation_error") ? errorText(apply.error) : errors._form} />
        <Field id="my-type" label="Leave type" error={errors.leave_type}>
          <Select value={form.leave_type} onValueChange={(v) => setForm({ ...form, leave_type: v })}>
            <SelectTrigger id="my-type" className="h-11 w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
            <SelectContent>{[...options].map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="my-from" label="From" error={errors.from_date}><Input id="my-from" type="date" className="h-11" value={form.from_date} min={`${year - 1}-01-01`} onChange={(e) => setForm({ ...form, from_date: e.target.value, to_date: e.target.value > form.to_date ? e.target.value : form.to_date })} required /></Field>
          <Field id="my-to" label="To" error={errors.to_date}><Input id="my-to" type="date" className="h-11" value={form.to_date} min={form.from_date} onChange={(e) => setForm({ ...form, to_date: e.target.value })} required /></Field>
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="num font-medium text-foreground">{days}</span> calendar day{days === 1 ? "" : "s"}, weekends included.
          {balance && <> You have <span className="num font-medium text-foreground">{trimDecimal(balance.available)}</span> available.</>}
        </p>
        {short && <p role="alert" className="text-sm text-status-pending">That&apos;s more than your available balance.</p>}
        <Field id="my-reason" label="Reason" hint="Optional" error={errors.reason}>
          <Input id="my-reason" className="h-11" value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Field>
        <Button type="submit" size="lg" disabled={apply.isPending || !form.leave_type || days === 0}>Request leave</Button>
      </form>
    </Card>
  );
}

function MyLeave() {
  const types = useTypeLabel();
  const balances = useQuery({ queryKey: ["people", "my", "leave-balances"], queryFn: () => unwrap(api.GET("/api/v1/hr/my/leave-balances/")) });
  const requests = useQuery({ queryKey: ["people", "my", "leave-requests"], queryFn: () => unwrap(api.GET("/api/v1/hr/my/leave-requests/")) });
  const year = Number(today().slice(0, 4));
  const current = (balances.data ?? []).filter((b) => b.year === year);
  return (
    <div className="grid grid-cols-1 gap-5">
      <section aria-labelledby="balances-heading">
        <h2 id="balances-heading" className="type-section mb-2">Balances {year}</h2>
        {balances.isLoading ? <RowsSkeleton rows={2} /> : balances.error ? <ErrorState error={balances.error} onRetry={balances.refetch} /> : current.length === 0 ? (
          <p className="text-sm text-muted-foreground">No leave allocated for {year} yet.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {current.map((b) => (
              <li key={b.id} className="rounded-lg border bg-card px-3 py-2.5">
                <p className="truncate text-sm text-muted-foreground">{types.name(b.leave_type)}</p>
                <p className="num text-2xl font-semibold">{trimDecimal(b.available)}</p>
                <p className="num text-xs text-muted-foreground">of {trimDecimal(b.allocated)} · {trimDecimal(b.used)} used</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ApplyForm balances={balances.data ?? []} />
      <section aria-labelledby="requests-heading">
        <h2 id="requests-heading" className="type-section mb-2">My requests</h2>
        {requests.isLoading ? <RowsSkeleton rows={3} /> : requests.error ? <ErrorState error={requests.error} onRetry={requests.refetch} /> : requests.data!.length === 0 ? (
          <Card><EmptyState title="No leave requests yet" /></Card>
        ) : (
          <ul className="grid grid-cols-1 gap-2">
            {requests.data!.map((r) => (
              <li key={r.id}>
                <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{types.name(r.leave_type)} · <span className="num">{trimDecimal(r.days)}</span> day{compareDecimal(r.days, "1") === 0 ? "" : "s"}</p>
                    <p className="num text-sm text-muted-foreground">{date(r.from_date)} – {date(r.to_date)}</p>
                    {r.reason && <p className="truncate text-sm text-muted-foreground">{r.reason}</p>}
                  </div>
                  <DocStatus status={r.status} />
                  {canCancelLeave(r) && <CancelLeave request={r} />}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function MyLeaveView() {
  return (
    <SelfService title="My leave" description="Check your balance, apply, and follow your requests.">
      {() => <MyLeave />}
    </SelfService>
  );
}
