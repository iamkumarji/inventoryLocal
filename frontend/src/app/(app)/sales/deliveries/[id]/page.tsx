import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { DeliveryDetail } from "./delivery-detail";

export const metadata: Metadata = { title: "Delivery" };

export default function Page() {
  return (
    <ClientPage>
      <DeliveryDetail />
    </ClientPage>
  );
}
