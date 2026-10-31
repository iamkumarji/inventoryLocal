import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { RunDetail } from "./run-detail";

export const metadata: Metadata = { title: "Payroll run" };

export default function Page() {
  return (
    <ClientPage>
      <RunDetail />
    </ClientPage>
  );
}
