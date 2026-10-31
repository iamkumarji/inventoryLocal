import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ItemDetail } from "./item-detail";

export const metadata: Metadata = { title: "Item" };

export default function Page() {
  return (
    <ClientPage>
      <ItemDetail />
    </ClientPage>
  );
}
