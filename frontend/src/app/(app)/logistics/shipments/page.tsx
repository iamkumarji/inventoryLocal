import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ShipmentsView } from "./shipments-view";

export const metadata: Metadata = { title: "Shipments" };

export default function Page() {
  return (
    <ClientPage>
      <ShipmentsView />
    </ClientPage>
  );
}
