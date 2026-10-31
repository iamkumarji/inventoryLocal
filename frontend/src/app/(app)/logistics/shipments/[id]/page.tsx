import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ShipmentDetail } from "./shipment-detail";

export const metadata: Metadata = { title: "Shipment" };

export default function Page() {
  return (
    <ClientPage>
      <ShipmentDetail />
    </ClientPage>
  );
}
