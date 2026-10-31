import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { NewClaimView } from "./new-claim-view";

export const metadata: Metadata = { title: "New expense claim" };

export default function Page() {
  return (
    <ClientPage>
      <NewClaimView />
    </ClientPage>
  );
}
