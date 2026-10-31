import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ReportExportsView } from "./report-exports-view";

export const metadata: Metadata = { title: "Report exports" };

export default function Page() {
  return (
    <ClientPage>
      <ReportExportsView />
    </ClientPage>
  );
}
