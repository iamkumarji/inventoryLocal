import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { CountDetail } from "./count-detail";

export const metadata: Metadata = { title: "Stock count" };

export default function Page() {
  return (
    <ClientPage>
      <CountDetail />
    </ClientPage>
  );
}
