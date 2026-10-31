import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { PayrollView } from "./payroll-view";

export const metadata: Metadata = { title: "Payroll" };

export default function Page() {
  return (
    <ClientPage>
      <PayrollView />
    </ClientPage>
  );
}
