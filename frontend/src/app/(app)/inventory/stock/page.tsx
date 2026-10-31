import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { StockView } from "./stock-view";

export const metadata: Metadata = { title: "Stock on hand" };

export default function Page() {
  return (
    <ClientPage>
      <StockView />
    </ClientPage>
  );
}
