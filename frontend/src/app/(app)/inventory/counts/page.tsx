import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { CountsView } from "./counts-view";

export const metadata: Metadata = { title: "Stock counts" };

export default function Page() {
  return (
    <ClientPage>
      <CountsView />
    </ClientPage>
  );
}
