import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";
import { PartnerDetail } from "@/components/trade/partners";

export const metadata: Metadata = { title: "Customer" };

export default function Page() {
  return (
    <ClientPage>
      <PartnerDetail kind="customer" />
    </ClientPage>
  );
}
