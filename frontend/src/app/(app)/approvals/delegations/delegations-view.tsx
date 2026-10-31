"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, format } from "date-fns";
import { Plus, UserRoundCog } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { PersonPicker, type Person } from "@/components/erp/person-picker";
import { StatusBadge } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

type Delegation = components["schemas"]["Delegation"];

function NewDelegation() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [delegate, setDelegate] = useState<Person | null>(null);
  const [from, setFrom] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [until, setUntil] = useState(() => format(addDays(new Date(), 7), "yyyy-MM-dd"));
  const [reason, setReason] = useState("");
  const create = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/api/v1/approvals/delegations/", {
        body: {
          delegate: delegate!.id,
          valid_from: new Date(`${from}T00:00:00`).toISOString(),
          valid_until: new Date(`${until}T23:59:59`).toISOString(),
          reason,
          document_types: [],
        },
      })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approvals", "delegations"] });
      setOpen(false);
      toast(`Approvals delegated to ${delegate?.full_name}`);
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus aria-hidden /> Delegate approvals</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Delegate your approvals</DialogTitle>
            <DialogDescription>
              The person you choose can decide steps you&apos;re responsible for, with your approval limits, until the end
              date. They can never approve their own requests.
            </DialogDescription>
          </DialogHeader>
          <FormError message={errors._form} />
          <Field id="delegate" label="Delegate to" error={errors.delegate}>
            <PersonPicker id="delegate" value={delegate} onChange={setDelegate} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="from" label="From" error={errors.valid_from}>
              <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
            </Field>
            <Field id="until" label="Until" error={errors.valid_until} hint="90 days at most">
              <Input id="until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} required />
            </Field>
          </div>
          <Field id="reason" label="Reason" error={errors.reason}>
            <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Annual leave" required />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={!delegate || !reason || create.isPending}>Delegate</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DelegationsView() {
  const { me } = useSession();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["approvals", "delegations"],
    queryFn: () => unwrap(api.GET("/api/v1/approvals/delegations/")),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/api/v1/approvals/delegations/{id}/revoke/", { params: { path: { id } } })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approvals", "delegations"] });
      toast("Delegation ended");
    },
  });

  const columns: Column<Delegation>[] = [
    {
      key: "who", header: "Arrangement",
      cell: (d) => d.delegator_detail.id === me.user.id
        ? <>You → <strong>{d.delegate_detail.full_name}</strong></>
        : <><strong>{d.delegator_detail.full_name}</strong> → you</>,
    },
    { key: "window", header: "Period", cell: (d) => <span className="text-muted-foreground">{dateTime(d.valid_from)} to {dateTime(d.valid_until)}</span> },
    { key: "reason", header: "Reason", cell: (d) => d.reason },
    {
      key: "status", header: "Status",
      cell: (d) => d.revoked_at ? <StatusBadge tone="neutral">Ended</StatusBadge>
        : d.is_active ? <StatusBadge tone="approved">In effect</StatusBadge> : <StatusBadge tone="info">Scheduled or expired</StatusBadge>,
    },
    {
      key: "actions", header: <span className="sr-only">Actions</span>, align: "right",
      cell: (d) => d.delegator_detail.id === me.user.id && !d.revoked_at && (
        <Button size="sm" variant="ghost" onClick={() => revoke.mutate(d.id)}>End now</Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Approvals", href: "/approvals" }, { label: "Delegations" }]}
        title="Delegations"
        description="Hand your approvals to a colleague while you're away, and see who has delegated to you."
        actions={<NewDelegation />}
      />
      <Section>
        <DataTable columns={columns} rows={query.data} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          empty={<EmptyState icon={UserRoundCog} title="No delegations" description="Delegate before leave so requests don't wait for you." />} />
      </Section>
    </>
  );
}
