import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ReportsView } from "./reports-view";

export const metadata: Metadata = { title: "Financial statements" };

export default function Page() {
  return (
    <ClientPage>
      <ReportsView />
    </ClientPage>
  );
}
