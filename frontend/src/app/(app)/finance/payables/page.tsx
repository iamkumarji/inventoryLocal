import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { PayablesView } from "./payables-view";

export const metadata: Metadata = { title: "Payables" };

export default function Page() {
  return (
    <ClientPage>
      <PayablesView />
    </ClientPage>
  );
}
