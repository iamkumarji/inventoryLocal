import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { InvoicesView } from "./invoices-view";

export const metadata: Metadata = { title: "Sales invoices" };

export default function Page() {
  return (
    <ClientPage>
      <InvoicesView />
    </ClientPage>
  );
}
