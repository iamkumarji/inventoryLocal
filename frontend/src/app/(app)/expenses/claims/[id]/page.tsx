import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ClaimDetail } from "./claim-detail";

export const metadata: Metadata = { title: "Expense claim" };

export default function Page() {
  return (
    <ClientPage>
      <ClaimDetail />
    </ClientPage>
  );
}
