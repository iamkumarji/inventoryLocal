import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { SalesReturnDetail } from "./return-detail";

export const metadata: Metadata = { title: "Sales return" };

export default function Page() {
  return (
    <ClientPage>
      <SalesReturnDetail />
    </ClientPage>
  );
}
