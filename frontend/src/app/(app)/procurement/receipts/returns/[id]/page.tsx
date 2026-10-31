import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { PurchaseReturnDetail } from "./return-detail";

export const metadata: Metadata = { title: "Purchase return" };

export default function Page() {
  return (
    <ClientPage>
      <PurchaseReturnDetail />
    </ClientPage>
  );
}
