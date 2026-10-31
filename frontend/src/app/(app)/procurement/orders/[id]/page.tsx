import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { OrderDetail } from "./order-detail";

export const metadata: Metadata = { title: "Purchase order" };

export default function Page() {
  return (
    <ClientPage>
      <OrderDetail />
    </ClientPage>
  );
}
