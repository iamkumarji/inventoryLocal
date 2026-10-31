"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";

import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { Facts } from "@/components/people/actions";
import { Amount, DocStatus } from "@/components/people/amount";
import { AdvanceActions } from "@/components/people/claim-actions";
import { api, unwrap } from "@/lib/api/client";
import { date, dateTime } from "@/lib/format";

export function AdvanceDetail() {
  const { id } = useParams<{ id: string }>();
  const advance = useQuery({
    queryKey: ["people", "advance", id],
    queryFn: () => unwrap(api.GET("/api/v1/expenses/advances/{id}/", { params: { path: { id } } })),
  });
  if (advance.isLoading) return <PageSkeleton />;
  if (advance.error) return <ErrorState error={advance.error} onRetry={advance.refetch} />;
  const a = advance.data!;
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Expense claims", href: "/expenses?tab=advances" }, { label: a.number }]}
        title={`Advance for ${a.employee_name}`}
        meta={<><DocStatus status={a.status} /><span className="text-muted-foreground">{a.number}</span></>}
        actions={<AdvanceActions advance={a} />}
      />
      <Section title="Details" className="max-w-2xl">
        <Facts items={[
          ["Purpose", a.purpose],
          ["Amount", <Amount key="a" value={a.amount} currency={a.currency} />],
          ["Settled by claims", <Amount key="s" value={a.settled_amount} currency={a.currency} />],
          ["Outstanding", <Amount key="o" value={a.outstanding} currency={a.currency} />],
          ["Paid on", a.paid_on ? date(a.paid_on) : "—"],
          ["Bank reference", a.bank_reference || "—"],
          ["Requested", dateTime(a.created_at)],
        ]} />
      </Section>
    </>
  );
}
