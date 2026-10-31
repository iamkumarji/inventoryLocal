import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { MaintenanceView } from "./maintenance-view";

export const metadata: Metadata = { title: "Maintenance" };

export default function Page() {
  return (
    <ClientPage>
      <MaintenanceView />
    </ClientPage>
  );
}
