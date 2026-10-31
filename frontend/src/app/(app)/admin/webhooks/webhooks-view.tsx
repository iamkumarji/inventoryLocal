"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, Webhook } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { OneTimeSecret } from "@/components/erp/one-time-secret";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { ago } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

import { type Endpoint, EventTypeList, EventTypesInput, eventTypesOf } from "./webhook-parts";

export const WEBHOOKS_KEY = ["integrations", "webhooks"] as const;

export function problemText(error: unknown): string | undefined {
  if (!error) return undefined;
  if (isApiError(error, "mfa_required")) return "This needs a fresh two-step verification. Try again and enter your code.";
  if (isApiError(error, "version_conflict")) return "Someone else changed this endpoint meanwhile. It has been reloaded; check it and try again.";
  return isApiError(error) ? error.summary() : "Couldn't reach the server.";
}

function NewEndpoint() {
  const { me } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [company, setCompany] = useState("all");
  const [events, setEvents] = useState<string[]>([]);
  const [created, setCreated] = useState<{ endpoint: Endpoint; secret: string } | null>(null);
  const create = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/integrations/webhooks/", {
      body: { name: name.trim(), url: url.trim(), event_types: events, company: company === "all" ? null : company },
    }))),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: WEBHOOKS_KEY });
      setCreated(result);
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setName(""); setUrl("https://"); setCompany("all"); setEvents([]); setCreated(null); create.reset();
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild><Button><Plus aria-hidden /> Add endpoint</Button></DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        {created ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Endpoint added</DialogTitle>
              <DialogDescription>
                {created.endpoint.name} receives signed POST requests at <span className="break-all">{created.endpoint.url}</span>.
              </DialogDescription>
            </DialogHeader>
            <OneTimeSecret label="Signing secret" value={created.secret}>
              <p><strong>Store it now, it can&apos;t be shown again.</strong> Put it in the receiving system&apos;s secret store; it verifies that requests come from OtabuPro. If it&apos;s lost, rotate the secret on the endpoint page.</p>
            </OneTimeSecret>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>Close</Button>
              <Button asChild><Link href={`/admin/webhooks/${created.endpoint.id}`} onClick={() => close(false)}>Open endpoint <ArrowRight aria-hidden /></Link></Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <DialogHeader>
              <DialogTitle>Add a webhook endpoint</DialogTitle>
              <DialogDescription>OtabuPro POSTs a signed JSON body to this address whenever a subscribed event happens, and retries with back-off when it fails.</DialogDescription>
            </DialogHeader>
            <FormError message={create.error && !isApiError(create.error, "validation_error") ? problemText(create.error) : errors._form} />
            <Field id="wh-name" label="Name" error={errors.name}>
              <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="e.g. Warehouse system" />
            </Field>
            <Field id="wh-url" label="Address (URL)" error={errors.url} hint="An https:// address that answers 2xx within 10 seconds.">
              <Input id="wh-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required maxLength={500} className="num" />
            </Field>
            <Field id="wh-company" label="Events from" error={errors.company}>
              <Select value={company} onValueChange={setCompany}>
                <SelectTrigger id="wh-company" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Every company</SelectItem>
                  {me.companies.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field id="wh-events" label="Events" error={errors.event_types}>
              <EventTypesInput id="wh-events" value={events} onChange={setEvents} invalid={Boolean(errors.event_types)} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
              <Button type="submit" disabled={create.isPending || events.length === 0 || !name.trim()}>
                {create.isPending ? "Adding…" : "Add endpoint"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function WebhooksView() {
  const { can, me } = useSession();
  const url = useUrlState();
  const status = url.get("status");
  const q = useQuery({
    queryKey: [...WEBHOOKS_KEY, status, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/integrations/webhooks/", {
      params: { query: { is_active: status === "" ? undefined : status === "active", page: url.page } },
    })),
  });
  const companyName = (id: string | null | undefined) => (id ? me.companies.find((c) => c.id === id)?.name ?? "One company" : "Every company");
  const columns: Column<Endpoint>[] = [
    { key: "name", header: "Endpoint", cell: (e) => <span className="block min-w-48"><span className="block">{e.name}</span><span className="num block max-w-72 truncate text-xs font-normal text-muted-foreground">{e.url}</span></span> },
    { key: "events", header: "Events", cell: (e) => <EventTypeList types={eventTypesOf(e)} /> },
    { key: "company", header: "From", cell: (e) => <span className="whitespace-nowrap">{companyName(e.company)}</span> },
    { key: "status", header: "Status", cell: (e) => <ActiveStatus active={e.is_active !== false} inactiveLabel="Paused" /> },
    { key: "updated", header: "Changed", cell: (e) => <span className="whitespace-nowrap text-muted-foreground">{ago(e.updated_at)}</span> },
  ];
  return (
    <>
      <PageHeader title="Webhooks" description="Send business events (an invoice posted, goods received…) to other systems as signed HTTPS requests."
        actions={can("integrations.webhook.create") && <NewEndpoint />} />
      <Section actions={
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
          {[["", "All"], ["active", "Active"], ["inactive", "Paused"]].map(([v, label]) => (
            <Button key={v || "all"} size="sm" variant={status === v ? "secondary" : "ghost"} aria-pressed={status === v} onClick={() => url.set({ status: v })}>{label}</Button>
          ))}
        </div>
      }>
        <DataTable columns={columns} rows={q.data?.results} isLoading={q.isLoading} error={q.error} onRetry={q.refetch}
          rowHref={(e) => `/admin/webhooks/${e.id}`} caption="Webhook endpoints"
          empty={<EmptyState icon={Webhook} title="No webhook endpoints" description="Add one to push events to an external system as they happen." />} />
        {q.data && <PageNav page={url.page} count={q.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
