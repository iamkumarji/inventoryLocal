import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { NewSupplierInvoice } from "./new-invoice";

export const metadata: Metadata = { title: "New supplier invoice" };

export default function Page() {
  return (
    <ClientPage>
      <NewSupplierInvoice />
    </ClientPage>
  );
}
