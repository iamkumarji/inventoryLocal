import type { ReactNode } from "react";

import { trimDecimal, type Payslip, type PayslipLine } from "@/lib/api/people";

import { Amount } from "./amount";

const KIND_LABEL: Record<string, string> = {
  earning: "Earnings",
  deduction: "Deductions",
  employer_contribution: "Employer contributions (not deducted from pay)",
};

function Lines({ kind, lines, currency }: { kind: string; lines: PayslipLine[]; currency: string }) {
  const rows = lines.filter((l) => l.kind === kind);
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">{KIND_LABEL[kind] ?? kind}</h3>
      <ul className="divide-y rounded-md border">
        {rows.map((l) => (
          <li key={l.code} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="block">{l.name}{l.is_statutory && <span className="ml-1.5 text-xs text-muted-foreground">statutory</span>}</span>
              {l.rate_pct && <span className="block text-xs text-muted-foreground"><span className="num">{trimDecimal(l.rate_pct)}%</span> of <Amount value={l.base_amount} currency={currency} /></span>}
            </span>
            <Amount value={l.amount} currency={currency} className="shrink-0" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Figure({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${strong ? "border-marking bg-marking/10" : ""}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 ${strong ? "text-lg font-semibold" : "font-medium"}`}>{children}</p>
    </div>
  );
}

/** A payslip's figures, days and lines. Withheld amounts show as "Restricted". */
export function PayslipBody({ slip, currency = "INR" }: { slip: Payslip; currency?: string }) {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Figure label="Gross pay"><Amount value={slip.gross} currency={currency} /></Figure>
        <Figure label="Deductions"><Amount value={slip.total_deductions} currency={currency} /></Figure>
        <Figure label="Net pay" strong><Amount value={slip.net_pay} currency={currency} /></Figure>
        <Figure label="Employer cost"><Amount value={slip.employer_contributions} currency={currency} /></Figure>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
        {([
          ["Days", slip.days_in_period],
          ["Present", slip.present_days],
          ["Paid leave", slip.paid_leave_days],
          ["Holidays", slip.holiday_days],
          ["Paid days", slip.paid_days],
          ["Loss of pay", slip.lop_days],
        ] as const).map(([label, value]) => (
          <div key={label} className="rounded-md bg-muted px-2.5 py-1.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="num font-medium">{trimDecimal(value)}</dd>
          </div>
        ))}
      </dl>
      {slip.lines ? (
        <div className="grid gap-4">
          {["earning", "deduction", "employer_contribution"].map((kind) => <Lines key={kind} kind={kind} lines={slip.lines!} currency={currency} />)}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Pay lines are restricted to people who can read salaries.</p>
      )}
    </div>
  );
}
