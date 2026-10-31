import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { LedgerView } from "./ledger-view";

export const metadata: Metadata = { title: "Stock ledger" };

export default function Page() {
  return (
    <ClientPage>
      <LedgerView />
    </ClientPage>
  );
}
