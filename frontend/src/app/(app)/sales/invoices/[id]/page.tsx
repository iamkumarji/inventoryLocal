import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { InvoiceDetail } from "./invoice-detail";

export const metadata: Metadata = { title: "Sales invoice" };

export default function Page() {
  return (
    <ClientPage>
      <InvoiceDetail />
    </ClientPage>
  );
}
