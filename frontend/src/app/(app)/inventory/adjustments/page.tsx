import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { AdjustmentsView } from "./adjustments-view";

export const metadata: Metadata = { title: "Stock adjustments" };

export default function Page() {
  return (
    <ClientPage>
      <AdjustmentsView />
    </ClientPage>
  );
}
