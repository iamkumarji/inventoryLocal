import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { WorkOrderDetail } from "./work-order-detail";

export const metadata: Metadata = { title: "Work order" };

export default function Page() {
  return (
    <ClientPage>
      <WorkOrderDetail />
    </ClientPage>
  );
}
