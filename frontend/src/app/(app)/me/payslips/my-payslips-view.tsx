"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Receipt } from "lucide-react";
import { useState } from "react";

import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Amount } from "@/components/people/amount";
import { PayslipBody } from "@/components/people/payslip";
import { Card, SelfService } from "@/components/people/self-service";
import { api, unwrap } from "@/lib/api/client";
import { MONTHS, SENSITIVE_QUERY, type Payslip } from "@/lib/api/people";

function label(period: string) {
  const [y, m] = period.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function MyPayslips() {
  const [open, setOpen] = useState<string | null>(null);
  const slips = useQuery({
    queryKey: ["people", "my", "payslips"],
    queryFn: () => unwrap(api.GET("/api/v1/hr/my/payslips/")) as Promise<Payslip[]>,
    ...SENSITIVE_QUERY,
  });
  if (slips.isLoading) return <RowsSkeleton rows={3} />;
  if (slips.error) return <ErrorState error={slips.error} onRetry={slips.refetch} />;
  if (slips.data!.length === 0) return <Card><EmptyState icon={Receipt} title="No payslips yet" description="Your payslip appears here once the month's payroll is posted." /></Card>;
  return (
    <ul className="grid gap-2">
      {slips.data!.map((s) => {
        const expanded = open === s.id;
        return (
          <li key={s.id}>
            <Card>
              <button type="button" className="flex w-full items-center gap-3 px-4 py-3.5 text-left" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : s.id)}>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{label(s.period)}</span>
                  <span className="block text-sm text-muted-foreground">Net pay</span>
                </span>
                <Amount value={s.net_pay} className="text-lg font-semibold" />
                <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
              </button>
              {expanded && <div className="border-t px-4 py-4"><PayslipBody slip={s} /></div>}
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

export function MyPayslipsView() {
  return (
    <SelfService title="My payslips" description="Your pay for each posted month. Only you can see these figures.">
      {() => <MyPayslips />}
    </SelfService>
  );
}
