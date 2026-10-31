"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";

import { PageHeader, Section } from "@/components/erp/page-header";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { Facts } from "@/components/people/actions";
import { DocStatus } from "@/components/people/amount";
import { api, unwrap } from "@/lib/api/client";
import { trimDecimal, useLeaveTypes } from "@/lib/api/people";
import { date, dateTime } from "@/lib/format";

import { LeaveRowActions } from "../../leave/leave-view";

/** One leave request (linked from approvals and notifications). */
export function LeaveRequestDetail() {
  const { id } = useParams<{ id: string }>();
  const types = useLeaveTypes();
  const request = useQuery({
    queryKey: ["people", "leave-request", id],
    queryFn: () => unwrap(api.GET("/api/v1/hr/leave-requests/{id}/", { params: { path: { id } } })),
  });
  if (request.isLoading) return <PageSkeleton />;
  if (request.error) return <ErrorState error={request.error} onRetry={request.refetch} />;
  const r = request.data!;
  const type = types.data?.results.find((t) => t.id === r.leave_type);
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Leave", href: "/hr/leave" }, { label: "Request" }]}
        title={`${r.employee_name}: ${type?.name ?? "Leave"}`}
        meta={<><DocStatus status={r.status} /><span className="text-muted-foreground">{r.employee_code}</span></>}
        actions={<LeaveRowActions request={r} />}
      />
      <Section title="Details" className="max-w-2xl">
        <Facts items={[
          ["From", date(r.from_date)],
          ["To", date(r.to_date)],
          ["Days", <span key="d" className="num">{trimDecimal(r.days)} (calendar days, both ends included)</span>],
          ["Paid", type ? (type.is_paid ? "Paid leave" : "Unpaid leave") : "—"],
          ["Reason", r.reason || "—"],
          ["Filed", dateTime(r.created_at)],
        ]} />
      </Section>
    </>
  );
}
