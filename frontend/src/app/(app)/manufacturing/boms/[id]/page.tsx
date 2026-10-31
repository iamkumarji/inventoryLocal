import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { BomDetail } from "./bom-detail";

export const metadata: Metadata = { title: "Bill of materials" };

export default function Page() {
  return (
    <ClientPage>
      <BomDetail />
    </ClientPage>
  );
}
