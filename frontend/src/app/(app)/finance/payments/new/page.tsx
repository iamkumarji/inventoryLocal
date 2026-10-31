import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { NewPayment } from "./new-payment";

export const metadata: Metadata = { title: "New payment" };

export default function Page() {
  return (
    <ClientPage>
      <NewPayment />
    </ClientPage>
  );
}
