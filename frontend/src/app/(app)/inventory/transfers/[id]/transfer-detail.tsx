"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, PackageCheck, Truck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, Facts, NextStep, Who } from "@/components/inventory/bits";
import { qty } from "@/components/inventory/decimal";
import { InvStatus } from "@/components/inventory/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { todayIso, useLocations, useWarehouses, type Transfer } from "@/lib/api/inventory";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

type Line = Transfer["lines"][number];

function BatchLabel({ id }: { id: string | null | undefined }) {
  const { can } = useSession();
  const q = useQuery({
    queryKey: ["inventory", "batch", id],
    queryFn: () => unwrap(api.GET("/api/v1/inventory/batches/{id}/", { params: { path: { id: id! } } })),
    enabled: !!id && can("inventory.batch.read"),
    staleTime: 5 * 60_000,
  });
  if (!id) return <span className="text-muted-foreground">—</span>;
  return <span className="num">{q.data?.batch_number ?? "Batch"}</span>;
}

function Stepper({ status }: { status: string }) {
  const steps = [["draft", "Draft"], ["dispatched", "In transit"], ["received", "Received"]] as const;
  const at = steps.findIndex(([s]) => s === status);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Transfer progress">
      {steps.map(([s, label], i) => (
        <li key={s} className="flex items-center gap-2">
          <span aria-current={i === at ? "step" : undefined}
            className={cn("rounded-sm border px-2 py-0.5", i < at && "border-status-approved/30 text-status-approved", i === at && "border-foreground bg-primary font-semibold text-primary-foreground", i > at && "text-muted-foreground")}>
            {label}
          </span>
          {i < steps.length - 1 && <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

export function TransferDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const wh = useWarehouses({ activeCompanyOnly: false });
  const key = ["inventory", "transfer", id];
  const query = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/api/v1/inventory/transfers/{id}/", { params: { path: { id } } })) });
  const [on, setOn] = useState(todayIso());
  const canBins = can("inventory.location.read");
  const fromBins = useLocations(query.data?.from_warehouse, canBins).data?.results ?? [];
  const toBins = useLocations(query.data?.to_warehouse, canBins).data?.results ?? [];

  const act = useMutation({
    mutationFn: (verb: "dispatch" | "receive") => {
      const t = query.data!;
      const params = { path: { id }, header: { "Idempotency-Key": idempotencyKey() } };
      const body = { on, version: t.version };
      return unwrap(verb === "dispatch"
        ? api.POST("/api/v1/inventory/transfers/{id}/dispatch/", { params, body })
        : api.POST("/api/v1/inventory/transfers/{id}/receive/", { params, body }));
    },
    onSuccess: (t, verb) => {
      queryClient.setQueryData(key, t);
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      toast(verb === "dispatch" ? `Dispatched as ${t.number}; stock is in transit` : "Received into the destination warehouse");
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict") || isApiError(error, "invalid_state_transition")) query.refetch();
    },
  });

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const t = query.data!;
  const columns: Column<Line>[] = [
    { key: "item", header: "Item", cell: (l) => <span className="num font-medium">{l.item_code}</span> },
    { key: "qty", header: "Quantity", align: "right", cell: (l) => <span className="num">{qty(l.quantity)}</span> },
    { key: "batch", header: "Batch", cell: (l) => <BatchLabel id={l.batch} /> },
    { key: "serials", header: "Serials", cell: (l) => { const s = (l.serials as string[] | undefined) ?? []; return <span className="num text-xs">{s.length ? s.join(", ") : "—"}</span>; } },
    { key: "bins", header: "Bins", cell: (l) => {
      if (!l.from_location && !l.to_location) return <span className="text-muted-foreground">—</span>;
      const code = (bins: typeof fromBins, id: string | null | undefined) => (id ? bins.find((b) => b.id === id)?.code ?? "Bin" : "Any");
      return <span className="num inline-flex items-center gap-1 whitespace-nowrap">{code(fromBins, l.from_location)}<ArrowRight className="size-3 text-muted-foreground" aria-label="to" />{code(toBins, l.to_location)}</span>;
    } },
  ];
  const dateField = (verb: string) => (
    <div className="flex items-center gap-2">
      <Label htmlFor="move-date" className="shrink-0 text-muted-foreground">{verb} on</Label>
      <Input id="move-date" type="date" value={on} min={verb === "Received" ? t.dispatched_on ?? undefined : undefined} max={todayIso()} onChange={(e) => setOn(e.target.value)} className="h-9 w-40" />
    </div>
  );

  const next = t.status === "draft" ? (
    can("inventory.stock_transfer.dispatch") ? (
      <NextStep title="Dispatch" body={<>Takes the stock out of <span className="num">{wh.label(t.from_warehouse)}</span> and holds it in transit at the destination until it&apos;s received.</>}>
        {dateField("Dispatched")}
        <Button onClick={() => act.mutate("dispatch")} disabled={act.isPending || !on}><Truck aria-hidden /> Dispatch</Button>
      </NextStep>
    ) : <NextStep title="Waiting for dispatch" body="Someone at the source warehouse dispatches it when the goods leave." />
  ) : t.status === "dispatched" ? (
    can("inventory.stock_transfer.receive") ? (
      <NextStep title="Receive" body={<>Confirms the goods arrived at <span className="num">{wh.label(t.to_warehouse)}</span> and makes them available there.</>}>
        {dateField("Received")}
        <Button onClick={() => act.mutate("receive")} disabled={act.isPending || !on}><PackageCheck aria-hidden /> Receive</Button>
      </NextStep>
    ) : <NextStep title="In transit" body="The destination warehouse receives it when the goods arrive." />
  ) : null;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Transfers", href: "/inventory/transfers" }, { label: t.number || "Draft" }]}
        title={t.number ? <span className="num">{t.number}</span> : "Draft transfer"}
        meta={<>
          <InvStatus kind="transfer" status={t.status} />
          <span className="num inline-flex items-center gap-1.5">{wh.label(t.from_warehouse)}<ArrowRight className="size-3.5 text-muted-foreground" aria-label="to" />{wh.label(t.to_warehouse)}</span>
        </>}
        actions={t.status !== "draft" && can("inventory.stock_ledger.read") && (
          <Button variant="outline" asChild><Link href={`/inventory/ledger?source_id=${t.id}`}><BookOpen aria-hidden /> Ledger entries</Link></Button>
        )}
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6">
          <Section>
            <div className="grid gap-4 px-5 py-4">
              <Stepper status={t.status} />
              {next}
              <ActionError error={act.error} denied={act.variables === "receive"
                ? "You can't receive into this warehouse. Receiving needs the receive permission at the destination."
                : "You can't dispatch from this warehouse."} />
            </div>
          </Section>
          <Section title="Lines">
            <DataTable columns={columns} rows={t.lines} caption="Transfer lines" />
          </Section>
        </div>
        <Section title="Details" className="min-w-0 self-start">
          <div className="px-5 py-4">
            <Facts items={[
              ["Created by", <Who key="c" id={t.created_by} />],
              ["Created", dateTime(t.created_at)],
              ["Dispatched", t.dispatched_on ? date(t.dispatched_on) : "—"],
              ["Dispatched by", <Who key="d" id={t.dispatched_by} />],
              ["Received", t.received_on ? date(t.received_on) : "—"],
              ["Received by", <Who key="r" id={t.received_by} />],
              t.notes ? ["Notes", t.notes] : null,
            ]} />
          </div>
        </Section>
      </div>
    </>
  );
}
