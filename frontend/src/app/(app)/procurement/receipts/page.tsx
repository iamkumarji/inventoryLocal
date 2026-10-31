import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ReceiptsView } from "./receipts-view";

export const metadata: Metadata = { title: "Goods receipts" };

export default function Page() {
  return (
    <ClientPage>
      <ReceiptsView />
    </ClientPage>
  );
}
