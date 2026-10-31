"use client";

import { PageHeader } from "@/components/erp/page-header";
import { TabStrip } from "@/components/people/actions";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

import { ComponentsTab } from "./components-tab";
import { PayslipsTab } from "./payslips-tab";
import { RunsTab } from "./runs-tab";
import { SalariesTab } from "./salaries-tab";
import { StructuresTab } from "./structures-tab";

export function PayrollView() {
  const { can } = useSession();
  const url = useUrlState();
  const tabs = [
    can("hr.payroll_run.read") && { value: "runs", label: "Payroll runs" },
    can("hr.payslip.read") && { value: "payslips", label: "Payslips" },
    can("hr.salary.read") && { value: "salaries", label: "Salaries" },
    can("hr.salary_structure.read") && { value: "structures", label: "Structures" },
    can("hr.salary_structure.read") && { value: "components", label: "Components" },
  ].filter(Boolean) as { value: string; label: string }[];
  const tab = url.get("tab") || tabs[0]?.value || "runs";
  return (
    <>
      <PageHeader title="Payroll" description="Compute monthly pay from attendance and salary structures, send it for approval, then post it to the ledger." />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v, status: null, employee: null, run: null })}>
        <TabStrip>
          <TabsList>{tabs.map((t) => <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>)}</TabsList>
        </TabStrip>
      </Tabs>
      {tab === "runs" && <RunsTab />}
      {tab === "payslips" && <PayslipsTab />}
      {tab === "salaries" && <SalariesTab />}
      {tab === "structures" && <StructuresTab />}
      {tab === "components" && <ComponentsTab />}
    </>
  );
}
