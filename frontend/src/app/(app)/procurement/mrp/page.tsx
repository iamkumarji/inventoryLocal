import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { MrpView } from "./mrp-view";

export const metadata: Metadata = { title: "MRP" };

export default function Page() {
  return (
    <ClientPage>
      <MrpView />
    </ClientPage>
  );
}
