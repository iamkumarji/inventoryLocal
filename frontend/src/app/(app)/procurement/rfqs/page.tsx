import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { RfqsView } from "./rfqs-view";

export const metadata: Metadata = { title: "RFQs" };

export default function Page() {
  return (
    <ClientPage>
      <RfqsView />
    </ClientPage>
  );
}
