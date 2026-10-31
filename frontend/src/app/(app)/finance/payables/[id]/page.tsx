import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { SupplierInvoiceDetail } from "./invoice-detail";

export const metadata: Metadata = { title: "Supplier invoice" };

export default function Page() {
  return (
    <ClientPage>
      <SupplierInvoiceDetail />
    </ClientPage>
  );
}
