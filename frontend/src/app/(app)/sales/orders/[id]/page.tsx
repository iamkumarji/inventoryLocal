import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { SalesOrderDetail } from "./order-detail";

export const metadata: Metadata = { title: "Sales order" };

export default function Page() {
  return (
    <ClientPage>
      <SalesOrderDetail />
    </ClientPage>
  );
}
