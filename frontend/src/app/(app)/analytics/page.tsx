import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { DashboardsView } from "./dashboards-view";

export const metadata: Metadata = { title: "Dashboards" };

export default function Page() {
  return (
    <ClientPage>
      <DashboardsView />
    </ClientPage>
  );
}
