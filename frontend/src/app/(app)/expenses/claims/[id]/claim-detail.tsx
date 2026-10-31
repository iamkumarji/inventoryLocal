"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";

import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { Facts } from "@/components/people/actions";
import { Amount, DocStatus } from "@/components/people/amount";
import { ClaimLines } from "@/components/people/claim";
import { ClaimActions } from "@/components/people/claim-actions";
import { ClaimAttachments } from "@/components/people/receipts";
import { api, unwrap } from "@/lib/api/client";
import { compareDecimal } from "@/lib/api/people";
import { date, dateTime } from "@/lib/format";

export function ClaimDetail() {
  const { id } = useParams<{ id: string }>();
  const claim = useQuery({
    queryKey: ["people", "claim", id],
    queryFn: () => unwrap(api.GET("/api/v1/expenses/claims/{id}/", { params: { path: { id } } })),
  });
  if (claim.isLoading) return <PageSkeleton />;
  if (claim.error) return <ErrorState error={claim.error} onRetry={claim.refetch} />;
  const c = claim.data!;
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Expense claims", href: "/expenses" }, { label: c.number }]}
        title={`${c.employee_name}: ${c.purpose}`}
        meta={<><DocStatus status={c.status} /><span className="text-muted-foreground">{c.number}</span><span className="font-medium"><Amount value={c.amount} currency={c.currency} /></span></>}
        actions={<ClaimActions claim={c} />}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Section title="Expenses">
          <ClaimLines claim={c} />
          <ClaimAttachments claimId={c.id} />
        </Section>
        <Section title="Summary">
          <Facts items={[
            ["Claim date", date(c.claim_date)],
            ["Total", <Amount key="t" value={c.amount} currency={c.currency} />],
            ...(compareDecimal(c.advance_settled, "0") > 0 ? [["Advance settled", <Amount key="a" value={c.advance_settled} currency={c.currency} />] as [string, React.ReactNode]] : []),
            ["Payable to employee", <Amount key="n" value={c.net_payable} currency={c.currency} />],
            ["Approval journal", c.approval_journal ? "Posted" : "—"],
            ["Paid on", c.paid_on ? date(c.paid_on) : "—"],
            ["Bank reference", c.bank_reference || "—"],
            ["Filed", dateTime(c.created_at)],
          ]} />
        </Section>
      </div>
    </>
  );
}
