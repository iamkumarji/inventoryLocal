import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { TransfersView } from "./transfers-view";

export const metadata: Metadata = { title: "Stock transfers" };

export default function Page() {
  return (
    <ClientPage>
      <TransfersView />
    </ClientPage>
  );
}
