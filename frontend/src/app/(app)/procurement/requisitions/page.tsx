import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { RequisitionsView } from "./requisitions-view";

export const metadata: Metadata = { title: "Purchase requisitions" };

export default function Page() {
  return (
    <ClientPage>
      <RequisitionsView />
    </ClientPage>
  );
}
