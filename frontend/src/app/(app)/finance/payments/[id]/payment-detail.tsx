"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hourglass, Send, Stamp } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef } from "react";
import { toast } from "sonner";

import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState, ErrorState, PageSkeleton } from "@/components/erp/states";
import { ActionError } from "@/components/finance/action-error";
import { Amount } from "@/components/finance/amount";
import { DocStatus, Figures } from "@/components/finance/controls";
import { DecideDialog } from "@/components/finance/decide-dialog";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { MODE_LABEL, type Payment, fromUnits, sumDecimals, toUnits, useBankAccounts } from "@/lib/api/finance";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

import { KIND_LABEL } from "../payments-view";

type Act = { kind: "submit" } | { kind: "decide"; approve: boolean; comment: string } | { kind: "post" };

export function PaymentDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const banks = useBankAccounts();
  const q = useQuery({
    queryKey: ["finance", "payment", id],
    queryFn: () => unwrap(api.GET("/api/v1/finance/payments/{id}/", { params: { path: { id } } })),
  });
  const key = useRef<string | null>(null);
  const act = useMutation({
    mutationFn: ({ p, action }: { p: Payment; action: Act }) => withStepUp(() => {
      const path = { id: p.id };
      if (action.kind === "submit") return unwrap(api.POST("/api/v1/finance/payments/{id}/submit/", { params: { path }, body: { version: p.version } }));
      if (action.kind === "decide") {
        return unwrap(api.POST("/api/v1/finance/payments/{id}/decide/", { params: { path }, body: { approve: action.approve, comment: action.comment, version: p.version } }));
      }
      key.current ??= idempotencyKey();
      return unwrap(api.POST("/api/v1/finance/payments/{id}/post/", { params: { path, header: { "Idempotency-Key": key.current } }, body: { version: p.version } }));
    }),
    onSuccess: (p, { action }) => {
      key.current = null;
      queryClient.setQueryData(["finance", "payment", id], p);
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast(action.kind === "submit" ? (p.status === "approved" ? "Submitted and approved" : "Sent for approval")
        : action.kind === "post" ? `Posted as ${p.number}` : action.approve ? "Payment approved" : "Payment rejected");
    },
    onError: (error) => {
      key.current = null;
      if (isApiError(error) && error.status === 409) queryClient.invalidateQueries({ queryKey: ["finance", "payment", id] });
    },
  });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const p = q.data!;
  const run = (action: Act) => act.mutate({ p, action });
  const supplier = p.kind === "supplier_payment";
  const iSubmitted = p.submitted_by === me.user.id;
  const bank = banks.data?.results.find((b) => b.id === p.bank_account);
  const allocated = sumDecimals(p.allocations.map((a) => a.amount));
  const onAccount = fromUnits(toUnits(p.amount) - toUnits(allocated), 4);

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Payments", href: "/finance/payments" }, { label: p.number || (p.status === "draft" ? "Draft" : "Not posted") }]}
        title={`${KIND_LABEL[p.kind]}${supplier ? " to" : " from"} ${p.partner_name}`}
        meta={<>
          <DocStatus status={p.status} />
          {p.number && <span className="num text-muted-foreground">{p.number}</span>}
          <span className="text-muted-foreground">{date(p.payment_date)} · {MODE_LABEL[p.mode]}{p.reference ? ` · ${p.reference}` : ""}</span>
        </>}
        actions={<>
          {["draft", "rejected"].includes(p.status) && can("finance.payment.update") && (
            <Button onClick={() => run({ kind: "submit" })} disabled={act.isPending}><Send aria-hidden /> Submit</Button>
          )}
          {p.status === "submitted" && !iSubmitted && can("finance.payment.approve") && <>
            <DecideDialog approve title="Approve this payment?" pending={act.isPending}
              description={`You confirm ${p.partner_name} should be paid this amount. It can be posted once approved.`}
              onDecide={(comment) => run({ kind: "decide", approve: true, comment })} />
            <DecideDialog approve={false} title="Reject this payment?" pending={act.isPending}
              description="It goes back to the preparer." onDecide={(comment) => run({ kind: "decide", approve: false, comment })} />
          </>}
          {p.status === "approved" && can("finance.payment.post") && (
            <Button onClick={() => run({ kind: "post" })} disabled={act.isPending}><Stamp aria-hidden /> Post</Button>
          )}
        </>}
      />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
        {p.status === "submitted" && iSubmitted && (
          <p role="status" className="flex items-start gap-2 rounded-md border border-status-pending/30 bg-status-pending/10 px-3 py-2.5 text-sm text-status-pending">
            <Hourglass className="mt-0.5 size-4 shrink-0" aria-hidden />
            Waiting for another approver. You submitted this payment, so a different person with payment approval rights must approve it.
          </p>
        )}
        {p.status === "approved" && supplier && p.mode !== "cash" && (
          <p className="text-sm text-muted-foreground">Posting checks that {p.partner_name} has a verified bank account on file.</p>
        )}
        <ActionError error={act.error} forbidden="You can't do this step on this payment. Ask someone with payment approval or posting rights."
          hints={{ self_approval: "A different person with payment approval rights must approve it.", maker_checker: "Someone other than the preparer must approve it before it is posted." }} />
        <Figures items={[
          { label: "Amount", value: <Amount value={p.amount} /> },
          { label: "Allocated to invoices", value: <Amount value={allocated} /> },
          { label: "On account", value: <Amount value={onAccount} />, hint: "Settles future invoices" },
          {
            label: supplier ? "Paid from" : "Deposited to",
            value: bank ? `${bank.bank_name}${bank.account_last4 ? ` ••${bank.account_last4}` : ""}` : "—",
            hint: p.journal_entry ? <Link className="underline underline-offset-4" href={`/finance/journals/${p.journal_entry}`}>Ledger entry</Link> : undefined,
          },
        ]} />
        <Section title="Allocations">
          {p.allocations.length === 0 ? <EmptyState title="Not allocated" description="The full amount is on account." /> : (
            <LedgerTable caption="Allocations" columns={[{ key: "doc", header: "Document" }, { key: "amount", header: "Amount", align: "right" }]}>
              {p.allocations.map((a) => (
                <Row key={a.open_item}><Cell>{a.number}</Cell><Cell align="right"><Amount value={a.amount} /></Cell></Row>
              ))}
            </LedgerTable>
          )}
        </Section>
      </div>
    </>
  );
}
