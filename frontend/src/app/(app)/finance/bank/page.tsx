import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { BankView } from "./bank-view";

export const metadata: Metadata = { title: "Banking" };

export default function Page() {
  return (
    <ClientPage>
      <BankView />
    </ClientPage>
  );
}
