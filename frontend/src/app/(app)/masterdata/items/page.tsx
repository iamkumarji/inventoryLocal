import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ItemsView } from "./items-view";

export const metadata: Metadata = { title: "Items" };

export default function Page() {
  return (
    <ClientPage>
      <ItemsView />
    </ClientPage>
  );
}
