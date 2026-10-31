import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { TransferDetail } from "./transfer-detail";

export const metadata: Metadata = { title: "Stock transfer" };

export default function Page() {
  return (
    <ClientPage>
      <TransferDetail />
    </ClientPage>
  );
}
