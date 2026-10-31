"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Send, Stamp } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef } from "react";
import { toast } from "sonner";

import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError } from "@/components/finance/action-error";
import { Amount } from "@/components/finance/amount";
import { DocStatus, Figures, MatchStatus } from "@/components/finance/controls";
import { DecideDialog } from "@/components/finance/decide-dialog";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { type SupplierInvoice, formatDecimal, sumDecimals } from "@/lib/api/finance";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

type Note = { item: string; issue: string; po_rate?: string; billed_rate?: string; difference?: string; billed?: string; detail?: string };

type Act = { kind: "submit" } | { kind: "decide"; approve: boolean; comment: string } | { kind: "post" };

export function SupplierInvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["finance", "supplier-invoice", id],
    queryFn: () => unwrap(api.GET("/api/v1/finance/supplier-invoices/{id}/", { params: { path: { id } } })),
  });
  const key = useRef<string | null>(null);
  const act = useMutation({
    mutationFn: ({ inv, action }: { inv: SupplierInvoice; action: Act }) => withStepUp(() => {
      const path = { id: inv.id };
      if (action.kind === "submit") return unwrap(api.POST("/api/v1/finance/supplier-invoices/{id}/submit/", { params: { path }, body: { version: inv.version } }));
      if (action.kind === "decide") {
        return unwrap(api.POST("/api/v1/finance/supplier-invoices/{id}/decide/", { params: { path }, body: { approve: action.approve, comment: action.comment, version: inv.version } }));
      }
      key.current ??= idempotencyKey();
      return unwrap(api.POST("/api/v1/finance/supplier-invoices/{id}/post/", {
        params: { path, header: { "Idempotency-Key": key.current } }, body: { version: inv.version },
      }));
    }),
    onSuccess: (inv, { action }) => {
      key.current = null;
      queryClient.setQueryData(["finance", "supplier-invoice", id], inv);
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast(action.kind === "submit" ? (inv.status === "approved" ? "Matched and approved" : "Sent for approval (price variance)")
        : action.kind === "post" ? `Posted as ${inv.number}` : action.approve ? "Approved" : "Rejected");
    },
    onError: (error) => {
      key.current = null;
      if (isApiError(error) && error.status === 409) queryClient.invalidateQueries({ queryKey: ["finance", "supplier-invoice", id] });
    },
  });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const inv = q.data!;
  const notes = (Array.isArray(inv.match_notes) ? inv.match_notes : []) as Note[];
  const run = (action: Act) => act.mutate({ inv, action });

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Payables", href: "/finance/payables" }, { label: inv.supplier_invoice_number }]}
        title={`${inv.supplier_name} · ${inv.supplier_invoice_number}`}
        meta={<>
          <DocStatus status={inv.status} />
          <MatchStatus status={inv.match_status} />
          {inv.number && <span className="num text-muted-foreground">{inv.number}</span>}
          <span className="text-muted-foreground">Invoice {date(inv.invoice_date)} · due {date(inv.due_date)}</span>
          <span className="text-muted-foreground">{inv.intra_state ? "Intra-state (CGST + SGST)" : "Inter-state (IGST)"}</span>
        </>}
        actions={<>
          {["draft", "rejected"].includes(inv.status) && can("finance.supplier_invoice.update") && (
            <Button onClick={() => run({ kind: "submit" })} disabled={act.isPending}><Send aria-hidden /> Submit for matching</Button>
          )}
          {inv.status === "submitted" && can("finance.supplier_invoice.approve") && <>
            <DecideDialog approve title="Approve this invoice?" pending={act.isPending}
              description="You're accepting the price variance listed below. You can't approve an invoice you submitted." onDecide={(comment) => run({ kind: "decide", approve: true, comment })} />
            <DecideDialog approve={false} title="Reject this invoice?" pending={act.isPending}
              description="It goes back to draft for correction." onDecide={(comment) => run({ kind: "decide", approve: false, comment })} />
          </>}
          {inv.status === "approved" && can("finance.supplier_invoice.post") && (
            <Button onClick={() => run({ kind: "post" })} disabled={act.isPending}><Stamp aria-hidden /> Post to ledger</Button>
          )}
        </>}
      />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
        <ActionError error={act.error} forbidden="You can't do this step on this invoice. Approval needs someone other than the person who submitted it, within their approval limit." />
        <Figures items={[
          { label: "Taxable value", value: <Amount value={inv.subtotal} /> },
          { label: inv.intra_state ? "CGST + SGST" : "IGST", value: inv.intra_state ? <span className="num">{formatDecimal(inv.cgst, { currency: true })} + {formatDecimal(inv.sgst, { currency: true })}</span> : <Amount value={inv.igst} /> },
          { label: "Invoice total", value: <Amount value={inv.amount} /> },
          { label: "Ledger entry", value: inv.journal_entry ? <Link href={`/finance/journals/${inv.journal_entry}`} className="underline underline-offset-4">Open journal</Link> : <span className="text-muted-foreground">Not posted</span> },
        ]} />
        {inv.match_status !== "pending" && (
          <Section title="Three-way match" description="Billed quantity against received-and-not-yet-billed, billed rate against the order rate (within tolerance).">
            {notes.length === 0 ? (
              <p className="flex items-center gap-2 px-5 py-4 text-sm text-status-approved"><CheckCircle2 className="size-4" aria-hidden /> Quantities and rates agree with the receipt and the order.</p>
            ) : (
              <ul className="divide-y">
                {notes.map((n, i) => (
                  <li key={i} className="flex gap-2 px-5 py-3 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-pending" aria-hidden />
                    <span>
                      <span className="font-medium">{n.item}</span>:{" "}
                      {n.issue === "price"
                        ? <>billed at <span className="num">{formatDecimal(n.billed_rate)}</span> against the order rate <span className="num">{formatDecimal(n.po_rate)}</span>, a difference of <Amount value={n.difference} /> on this line.</>
                        : n.detail ?? `${n.issue} (billed ${n.billed})`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
        <Section title="Lines">
          <LedgerTable caption="Invoice lines" columns={[
            { key: "qty", header: "Quantity", align: "right" }, { key: "rate", header: "Rate", align: "right" },
            { key: "gst", header: "GST %", align: "right" }, { key: "taxable", header: "Taxable", align: "right" },
            { key: "tax", header: "Tax", align: "right" }, { key: "grn", header: "Against" },
          ]}>
            {inv.lines.map((l) => (
              <Row key={l.id}>
                <Cell align="right">{formatDecimal(l.quantity, { dp: 3 })}</Cell>
                <Cell align="right">{formatDecimal(l.rate)}</Cell>
                <Cell align="right">{formatDecimal(l.gst_rate)}</Cell>
                <Cell align="right"><Amount value={l.taxable_amount} currency={false} /></Cell>
                <Cell align="right"><Amount value={inv.intra_state ? sumDecimals([l.cgst, l.sgst]) : l.igst} currency={false} /></Cell>
                <Cell className="font-sans text-muted-foreground">{l.grn_line ? "Goods receipt line" : "Order line (service)"}</Cell>
              </Row>
            ))}
          </LedgerTable>
        </Section>
      </div>
    </>
  );
}
