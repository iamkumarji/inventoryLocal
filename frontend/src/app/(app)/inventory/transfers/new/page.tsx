import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { NewTransfer } from "./new-transfer";

export const metadata: Metadata = { title: "New stock transfer" };

export default function Page() {
  return (
    <ClientPage>
      <NewTransfer />
    </ClientPage>
  );
}
