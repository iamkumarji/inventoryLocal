import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { PaymentDetail } from "./payment-detail";

export const metadata: Metadata = { title: "Payment" };

export default function Page() {
  return (
    <ClientPage>
      <PaymentDetail />
    </ClientPage>
  );
}
