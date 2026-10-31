"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, RefreshCw, RotateCcw, Send } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { OneTimeSecret } from "@/components/erp/one-time-secret";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState, ErrorState, PageSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { ago, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

import { type Delivery, DeliveryStatus, type Endpoint, EventTypesInput, eventTypesOf } from "../webhook-parts";
import { WEBHOOKS_KEY, problemText } from "../webhooks-view";

function Settings({ endpoint }: { endpoint: Endpoint }) {
  const { can } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const editable = can("integrations.webhook.update");
  const [form, setForm] = useState({ name: "", url: "", events: [] as string[], active: true });
  const [syncedVersion, setSyncedVersion] = useState<number | null>(null);
  if (endpoint.version !== syncedVersion) {
    setSyncedVersion(endpoint.version);
    setForm({ name: endpoint.name, url: endpoint.url, events: eventTypesOf(endpoint), active: endpoint.is_active !== false });
  }
  const save = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.PATCH("/api/v1/integrations/webhooks/{id}/", {
      params: { path: { id: endpoint.id } },
      body: { name: form.name.trim(), url: form.url.trim(), event_types: form.events, is_active: form.active, version: endpoint.version },
    }))),
    onSuccess: (data) => {
      queryClient.setQueryData([...WEBHOOKS_KEY, "detail", endpoint.id], data);
      queryClient.invalidateQueries({ queryKey: WEBHOOKS_KEY, exact: false });
      toast("Endpoint saved");
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: [...WEBHOOKS_KEY, "detail", endpoint.id] });
    },
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  return (
    <Section title="Settings" description={editable ? "Pausing stops new deliveries; queued ones wait until it's active again." : undefined}>
      <form className="grid gap-4 px-5 py-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <FormError message={save.error && !isApiError(save.error, "validation_error") ? problemText(save.error) : errors._form} />
        <Field id="wh-name" label="Name" error={errors.name}>
          <Input id="wh-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={120} disabled={!editable} />
        </Field>
        <Field id="wh-url" label="Address (URL)" error={errors.url}>
          <Input id="wh-url" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required maxLength={500} className="num" disabled={!editable} />
        </Field>
        <Field id="wh-events" label="Events" error={errors.event_types}>
          {editable ? (
            <EventTypesInput id="wh-events" value={form.events} onChange={(events) => setForm({ ...form, events })} invalid={Boolean(errors.event_types)} />
          ) : (
            <p id="wh-events" className="num text-sm">{form.events.join(", ") || "None"}</p>
          )}
        </Field>
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
          <Label htmlFor="wh-active" className="font-normal">Active: deliver events to this address</Label>
          <Switch id="wh-active" checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} disabled={!editable} />
        </div>
        {editable && (
          <Button type="submit" variant="outline" className="justify-self-start" disabled={save.isPending || form.events.length === 0}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        )}
      </form>
    </Section>
  );
}

function Signature() {
  return (
    <Section title="Verifying requests" description="Check every request before trusting it.">
      <div className="grid gap-3 px-5 py-4 text-sm">
        <p>Each delivery is a POST with a JSON body and these headers:</p>
        <ul className="grid gap-1 pl-4 [list-style:disc]">
          <li><code className="num">X-ERP-Event</code>: the event type, e.g. <code className="num">sales.invoice.posted</code></li>
          <li><code className="num">X-ERP-Delivery</code>: a delivery id, the same on every retry (use it to ignore duplicates)</li>
          <li><code className="num">X-ERP-Timestamp</code>: Unix seconds when it was sent</li>
          <li><code className="num">X-ERP-Signature</code>: <code className="num break-all">sha256=HMAC_SHA256(secret, &quot;&lt;X-ERP-Timestamp&gt;.&quot; + raw body)</code> as lower-case hex</li>
        </ul>
        <p>
          Compute the HMAC over the <strong>raw request bytes</strong> (before parsing the JSON), compare it in constant time,
          and reject requests whose timestamp is more than a few minutes old. Answer with any 2xx status within 10 seconds;
          anything else is retried with growing delays, up to 10 attempts.
        </p>
        <pre className="num overflow-x-auto rounded-md border bg-muted px-3 py-2.5 text-xs leading-relaxed">{`expected = "sha256=" + hex(hmac_sha256(secret, timestamp + "." + raw_body))
valid    = constant_time_equals(expected, header["X-ERP-Signature"])
           and abs(now - int(timestamp)) <= 300`}</pre>
      </div>
    </Section>
  );
}

function Deliveries({ endpoint }: { endpoint: Endpoint }) {
  const { can } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const url = useUrlState();
  const key = [...WEBHOOKS_KEY, "deliveries", endpoint.id, url.page];
  const q = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET("/api/v1/integrations/webhooks/{id}/deliveries/", { params: { path: { id: endpoint.id }, query: { page: url.page } } })),
  });
  const redeliver = useMutation({
    mutationFn: (d: Delivery) => withStepUp(() => unwrap(api.POST("/api/v1/integrations/webhooks/{id}/deliveries/{delivery_id}/redeliver/", {
      params: { path: { id: endpoint.id, delivery_id: d.id } },
    }))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...WEBHOOKS_KEY, "deliveries", endpoint.id] });
      toast("Queued for delivery again");
    },
    onError: (error) => toast.error(problemText(error) ?? "Couldn't queue it again."),
  });
  const manage = can("integrations.webhook.manage");
  const columns: Column<Delivery>[] = [
    { key: "event", header: "Event", cell: (d) => <span className="block min-w-44"><span className="num block">{d.event_type}</span><span className="block text-xs text-muted-foreground">{dateTime(d.created_at)}</span></span> },
    { key: "status", header: "Status", cell: (d) => <DeliveryStatus status={d.status} /> },
    { key: "attempts", header: "Attempts", align: "right", cell: (d) => <span className="num">{d.attempts}</span> },
    { key: "code", header: "Response", cell: (d) => (
      <span className="block min-w-28">
        <span className="num block">{d.last_status_code ?? "—"}</span>
        {d.last_error && <span className="block max-w-56 truncate text-xs text-status-rejected" title={d.last_error}>{d.last_error}</span>}
      </span>
    ) },
    { key: "when", header: "Delivered / next try", cell: (d) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {d.delivered_at ? dateTime(d.delivered_at) : d.status === "dead" ? "Stopped retrying" : `Next ${dateTime(d.next_attempt_at)}`}
      </span>
    ) },
    ...(manage ? [{
      key: "action", header: <span className="sr-only">Actions</span>, align: "right" as const, cell: (d: Delivery) => d.status === "pending" ? null : (
        <Button size="sm" variant="ghost" disabled={redeliver.isPending} onClick={() => redeliver.mutate(d)}>
          <RotateCcw aria-hidden /> Redeliver
        </Button>
      ),
    }] : []),
  ];
  return (
    <Section title="Deliveries" description="Newest first. Failed deliveries are retried automatically with back-off."
      actions={<Button size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching}><RefreshCw aria-hidden /> Refresh</Button>}>
      <DataTable columns={columns} rows={q.data?.results} isLoading={q.isLoading} error={q.error} onRetry={q.refetch}
        caption="Webhook deliveries"
        empty={<EmptyState icon={History} title="Nothing delivered yet" description={manage ? "Send a test ping to check the address works." : "Deliveries appear here when subscribed events happen."} />} />
      {q.data && <PageNav page={url.page} count={q.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
    </Section>
  );
}

export function WebhookDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const q = useQuery({
    queryKey: [...WEBHOOKS_KEY, "detail", id],
    queryFn: () => unwrap(api.GET("/api/v1/integrations/webhooks/{id}/", { params: { path: { id } } })),
  });
  const rotate = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/integrations/webhooks/{id}/rotate-secret/", { params: { path: { id } } }))),
    onSuccess: (result) => {
      queryClient.setQueryData([...WEBHOOKS_KEY, "detail", id], result.endpoint);
      setSecret(result.secret);
    },
  });
  const test = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/integrations/webhooks/{id}/test/", { params: { path: { id } } }))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...WEBHOOKS_KEY, "deliveries", id] });
      toast("Test ping queued. It appears under Deliveries once sent.");
    },
  });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const endpoint = q.data!;
  const manage = can("integrations.webhook.manage");
  const actionError = rotate.error ?? test.error;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Webhooks", href: "/admin/webhooks" }, { label: endpoint.name }]}
        title={endpoint.name}
        meta={<><ActiveStatus active={endpoint.is_active !== false} inactiveLabel="Paused" /><span className="num min-w-0 break-all text-muted-foreground">{endpoint.url}</span><span className="text-muted-foreground">Changed {ago(endpoint.updated_at)}</span></>}
        actions={manage && <>
          <Button variant="outline" size="sm" disabled={test.isPending || endpoint.is_active === false} onClick={() => test.mutate()}
            title={endpoint.is_active === false ? "Activate the endpoint to send a test" : undefined}>
            <Send aria-hidden /> Send test ping
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={rotate.isPending}><RefreshCw aria-hidden /> Rotate secret</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Rotate the signing secret?</AlertDialogTitle>
                <AlertDialogDescription>
                  A new secret is generated and the current one stops working straight away: the receiving system rejects deliveries until
                  it has the new one. You&apos;ll see the new secret once.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => rotate.mutate()}>Rotate secret</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>}
      />
      {actionError && <div className="mb-4"><FormError message={problemText(actionError)} /></div>}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <Deliveries endpoint={endpoint} />
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <Settings endpoint={endpoint} />
          <Signature />
        </div>
      </div>
      <Dialog open={secret !== null} onOpenChange={(open) => { if (!open) setSecret(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New signing secret</DialogTitle>
            <DialogDescription>The previous secret no longer verifies. Update the receiving system now.</DialogDescription>
          </DialogHeader>
          {secret && (
            <OneTimeSecret label="Signing secret" value={secret}>
              <p><strong>Store it now, it can&apos;t be shown again.</strong></p>
            </OneTimeSecret>
          )}
          <DialogFooter><Button type="button" onClick={() => setSecret(null)}>I&apos;ve stored it</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
