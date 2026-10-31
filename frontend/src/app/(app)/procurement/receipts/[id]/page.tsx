import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ReceiptDetail } from "./receipt-detail";

export const metadata: Metadata = { title: "Goods receipt" };

export default function Page() {
  return (
    <ClientPage>
      <ReceiptDetail />
    </ClientPage>
  );
}
