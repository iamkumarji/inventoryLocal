import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { QuotationDetail } from "./quotation-detail";

export const metadata: Metadata = { title: "Quotation" };

export default function Page() {
  return (
    <ClientPage>
      <QuotationDetail />
    </ClientPage>
  );
}
