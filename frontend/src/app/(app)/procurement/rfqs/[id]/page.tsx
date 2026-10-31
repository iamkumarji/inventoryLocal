import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { RfqDetail } from "./rfq-detail";

export const metadata: Metadata = { title: "RFQ" };

export default function Page() {
  return (
    <ClientPage>
      <RfqDetail />
    </ClientPage>
  );
}
