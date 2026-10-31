import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { PaymentsView } from "./payments-view";

export const metadata: Metadata = { title: "Payments" };

export default function Page() {
  return (
    <ClientPage>
      <PaymentsView />
    </ClientPage>
  );
}
