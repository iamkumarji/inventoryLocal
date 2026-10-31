import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { SalesOrdersView } from "./orders-view";

export const metadata: Metadata = { title: "Sales orders" };

export default function Page() {
  return (
    <ClientPage>
      <SalesOrdersView />
    </ClientPage>
  );
}
