import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { AdjustmentDetail } from "./adjustment-detail";

export const metadata: Metadata = { title: "Stock adjustment" };

export default function Page() {
  return (
    <ClientPage>
      <AdjustmentDetail />
    </ClientPage>
  );
}
