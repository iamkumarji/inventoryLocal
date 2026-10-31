"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, EyeOff, Plus, Save, Stamp } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { StatusBadge } from "@/components/erp/status";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError, Facts, ItemPicker, NextStep, Who, type ItemOption } from "@/components/inventory/bits";
import { dec, isDecimal, qty, signedQty } from "@/components/inventory/decimal";
import { InvStatus } from "@/components/inventory/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { useWarehouses, type Count, type CountLine } from "@/lib/api/inventory";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

const POST_DENIED = "You can't approve this count. Counters can't approve a count they entered quantities on, and the person who started the count can't approve it either. Ask another approver.";

function variance(line: CountLine): string | null {
  if (line.counted_quantity === null || line.system_quantity === null) return null;
  return dec.sub(line.counted_quantity, line.system_quantity);
}

export function CountDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const queryClient = useQueryClient();
  const wh = useWarehouses({ activeCompanyOnly: false });
  const key = ["inventory", "count", id];
  const query = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/api/v1/inventory/counts/{id}/", { params: { path: { id } } })) });
  const lines = (query.data?.lines ?? []) as CountLine[];

  // Entry drafts keyed by line id, re-seeded whenever the server's counted values change.
  const serverCounts = lines.map((l) => `${l.id}:${l.counted_quantity ?? ""}`).join("|");
  const [seed, setSeed] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (query.data && seed !== serverCounts) {
    setSeed(serverCounts);
    setDrafts(Object.fromEntries(lines.map((l) => [l.id, l.counted_quantity === null ? "" : dec.normalize(l.counted_quantity)])));
  }
  const [found, setFound] = useState<{ item: ItemOption | null; quantity: string }>({ item: null, quantity: "" });
  const [localError, setLocalError] = useState<string | null>(null);

  const onDone = (c: Count, message: string) => {
    queryClient.setQueryData(key, c);
    queryClient.invalidateQueries({ queryKey: ["inventory", "counts"] });
    toast(message);
  };

  const record = useMutation({
    mutationFn: (entries: Array<{ line_id?: string; item_id?: string; counted_quantity: string }>) =>
      unwrap(api.POST("/api/v1/inventory/counts/{id}/record/", { params: { path: { id } }, body: entries })),
    onSuccess: (c, entries) => {
      onDone(c, entries.some((e) => e.item_id) ? "Found stock added to the count" : `${entries.length} count${entries.length === 1 ? "" : "s"} saved`);
      setFound({ item: null, quantity: "" });
    },
  });
  const post = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/inventory/counts/{id}/post/", {
      params: { path: { id }, header: { "Idempotency-Key": idempotencyKey() } }, body: { version: query.data!.version },
    })),
    onSuccess: (c) => {
      onDone(c, "Count approved; variances posted to stock");
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict") || isApiError(error, "invalid_state_transition")) query.refetch();
    },
  });

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const c = query.data!;
  const counting = c.status === "counting";
  const canCount = counting && can("inventory.stock_count.update");
  const canApprove = can("inventory.stock_count.approve");
  const allCounted = lines.length > 0 && lines.every((l) => l.counted_quantity !== null);
  const iCounted = lines.some((l) => l.counted_by === me.user.id);
  // In a blind count nobody sees the frozen quantity while entering counts. Approvers get it in the review
  // once every line is counted; the server withholds it from everyone else until the count is posted.
  const showSystemInEntry = !c.blind;
  const showReview = c.status === "posted" || (counting && canApprove && allCounted && lines.some((l) => l.system_quantity !== null));

  const changed = lines.filter((l) => {
    const d = (drafts[l.id] ?? "").trim();
    const current = l.counted_quantity === null ? "" : dec.normalize(l.counted_quantity);
    return d !== "" && d !== current;
  });

  const save = () => {
    for (const l of changed) {
      const v = drafts[l.id].trim();
      if (!isDecimal(v) || dec.isNegative(v)) {
        setLocalError(`${l.item_code}: enter the counted quantity as a number of zero or more.`);
        return;
      }
    }
    setLocalError(null);
    record.mutate(changed.map((l) => ({ line_id: l.id, counted_quantity: dec.normalize(drafts[l.id]) })));
  };

  const entryColumns: Column<CountLine>[] = [
    { key: "item", header: "Item", cell: (l) => <span><span className="num block font-medium">{l.item_code}</span><span className="block max-w-[26ch] truncate text-xs text-muted-foreground">{l.item_name}</span></span> },
    ...(showSystemInEntry ? [{ key: "sys", header: "System", align: "right" as const, cell: (l: CountLine) => <span className="num text-muted-foreground">{qty(l.system_quantity)}</span> }] : []),
    { key: "counted", header: "Counted", align: "right", className: "w-36", cell: (l) => canCount ? (
      <Input aria-label={`Counted quantity for ${l.item_code}`} inputMode="decimal" className="num h-8 text-right" value={drafts[l.id] ?? ""}
        onChange={(e) => setDrafts({ ...drafts, [l.id]: e.target.value })} />
    ) : <span className="num">{qty(l.counted_quantity)}</span> },
    { key: "by", header: "Counted by", cell: (l) => (l.counted_by ? <Who id={l.counted_by} /> : <span className="text-muted-foreground">Not counted</span>) },
  ];
  const reviewColumns: Column<CountLine>[] = [
    { key: "item", header: "Item", cell: (l) => <span className="num font-medium">{l.item_code}</span> },
    { key: "sys", header: "System", align: "right", cell: (l) => <span className="num">{qty(l.system_quantity)}</span> },
    { key: "cnt", header: "Counted", align: "right", cell: (l) => <span className="num">{qty(l.counted_quantity)}</span> },
    { key: "var", header: "Variance", align: "right", cell: (l) => {
      const v = variance(l);
      if (v === null) return "—";
      return <span className={`num font-medium ${dec.isZero(v) ? "text-muted-foreground" : dec.isNegative(v) ? "text-status-rejected" : "text-status-approved"}`}>{dec.isZero(v) ? "0" : signedQty(v)}</span>;
    } },
  ];

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Stock counts", href: "/inventory/counts" }, { label: c.number }]}
        title={<span className="num">{c.number}</span>}
        meta={<>
          <InvStatus kind="count" status={c.status} />
          {c.blind && <StatusBadge tone="info"><EyeOff className="size-3" aria-hidden /> Blind</StatusBadge>}
          <span className="num text-muted-foreground">{wh.label(c.warehouse)}</span>
          <span className="text-muted-foreground">{date(c.count_date)}</span>
        </>}
        actions={c.status === "posted" && c.stock_transaction && can("inventory.stock_ledger.read") && (
          <Button variant="outline" asChild><Link href={`/inventory/ledger?source_id=${c.id}`}><BookOpen aria-hidden /> Variance entries</Link></Button>
        )}
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <Section title="Count sheet" description={c.blind && counting ? "Blind count: enter what you find. System quantities stay hidden until the count is approved." : `${lines.length} line${lines.length === 1 ? "" : "s"}`}
            actions={canCount && <Button size="sm" onClick={save} disabled={record.isPending || changed.length === 0}><Save aria-hidden /> Save counts{changed.length ? ` (${changed.length})` : ""}</Button>}>
            {(localError || record.error) && (
              <div className="grid gap-2 border-b px-5 py-3">
                {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
                <ActionError error={record.error} denied="You can't enter counts in this warehouse." />
              </div>
            )}
            <DataTable columns={entryColumns} rows={lines} caption="Count sheet"
              empty={<p className="px-5 py-8 text-sm text-muted-foreground">No stock was on hand when the count started. Add anything you find below.</p>} />
            {canCount && (
              <form className="grid gap-3 border-t px-5 py-4 sm:grid-cols-[minmax(0,2fr)_8rem_auto] sm:items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!found.item || !isDecimal(found.quantity) || dec.isNegative(found.quantity)) { setLocalError("Choose the item you found and enter its quantity."); return; }
                  setLocalError(null);
                  record.mutate([{ item_id: found.item.id, counted_quantity: dec.normalize(found.quantity) }]);
                }}>
                <Field id="found-item" label="Found stock not on the sheet">
                  <ItemPicker id="found-item" value={found.item} onChange={(item) => setFound({ ...found, item })} />
                </Field>
                <Field id="found-qty" label="Quantity">
                  <Input id="found-qty" inputMode="decimal" className="num" value={found.quantity} onChange={(e) => setFound({ ...found, quantity: e.target.value })} />
                </Field>
                <Button type="submit" variant="outline" disabled={record.isPending}><Plus aria-hidden /> Add</Button>
              </form>
            )}
          </Section>

          {showReview && (
            <Section title={c.status === "posted" ? "Posted variances" : "Review variances"} description="Counted minus system quantity. Gains and losses post to the stock count variance account.">
              <DataTable columns={reviewColumns} rows={lines} caption="Count variances" />
            </Section>
          )}

          {counting && (
            <Section>
              <div className="grid gap-3 px-5 py-4">
                {canApprove ? (
                  <NextStep title="Approve and post"
                    body={allCounted
                      ? (iCounted ? "You entered counts on this sheet, so another approver has to post it." : "Posts every difference to stock and closes the count. This can't be undone.")
                      : "Every line needs a count before the variances can be posted."}>
                    <Button onClick={() => post.mutate()} disabled={post.isPending || !allCounted}><Stamp aria-hidden /> Approve and post</Button>
                  </NextStep>
                ) : (
                  <NextStep title={allCounted ? "Counted: waiting for approval" : "Counting in progress"}
                    body={allCounted ? "An approver who didn't count reviews the differences and posts them." : "Save counts as you go. When every line is counted, an approver posts the differences."} />
                )}
                <ActionError error={post.error} denied={POST_DENIED} />
              </div>
            </Section>
          )}
        </div>
        <Section title="Details" className="min-w-0 self-start">
          <div className="px-5 py-4">
            <Facts items={[
              ["Warehouse", <span key="w" className="num">{wh.label(c.warehouse)}</span>],
              ["Count date", date(c.count_date)],
              ["Type", c.blind ? "Blind (system quantity hidden)" : "Open"],
              ["Started by", <Who key="s" id={c.created_by} />],
              ["Started", dateTime(c.created_at)],
              ["Counted", `${lines.filter((l) => l.counted_quantity !== null).length} of ${lines.length} lines`],
              ["Approved by", <Who key="a" id={c.approved_by} />],
            ]} />
          </div>
        </Section>
      </div>
    </>
  );
}
