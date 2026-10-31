import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { DeliveriesView } from "./deliveries-view";

export const metadata: Metadata = { title: "Deliveries" };

export default function Page() {
  return (
    <ClientPage>
      <DeliveriesView />
    </ClientPage>
  );
}
