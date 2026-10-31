import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";
import { PartnerDetail } from "@/components/trade/partners";

export const metadata: Metadata = { title: "Supplier" };

export default function Page() {
  return (
    <ClientPage>
      <PartnerDetail kind="supplier" />
    </ClientPage>
  );
}
