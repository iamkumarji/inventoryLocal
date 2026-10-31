import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ReceivablesView } from "./receivables-view";

export const metadata: Metadata = { title: "Receivables" };

export default function Page() {
  return (
    <ClientPage>
      <ReceivablesView />
    </ClientPage>
  );
}
