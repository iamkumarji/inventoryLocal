import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { OrdersView } from "./orders-view";

export const metadata: Metadata = { title: "Production orders" };

export default function Page() {
  return (
    <ClientPage>
      <OrdersView />
    </ClientPage>
  );
}
