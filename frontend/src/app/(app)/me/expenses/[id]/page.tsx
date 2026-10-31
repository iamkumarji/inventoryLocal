import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { MyClaimView } from "./my-claim-view";

export const metadata: Metadata = { title: "Expense claim" };

export default function Page() {
  return (
    <ClientPage>
      <MyClaimView />
    </ClientPage>
  );
}
