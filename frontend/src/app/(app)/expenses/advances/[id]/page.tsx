import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { AdvanceDetail } from "./advance-detail";

export const metadata: Metadata = { title: "Employee advance" };

export default function Page() {
  return (
    <ClientPage>
      <AdvanceDetail />
    </ClientPage>
  );
}
