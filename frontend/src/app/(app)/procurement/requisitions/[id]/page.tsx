import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { RequisitionDetail } from "./requisition-detail";

export const metadata: Metadata = { title: "Purchase requisition" };

export default function Page() {
  return (
    <ClientPage>
      <RequisitionDetail />
    </ClientPage>
  );
}
