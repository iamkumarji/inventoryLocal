import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";
import { PartnerList } from "@/components/trade/partners";

export const metadata: Metadata = { title: "Customers" };

export default function Page() {
  return (
    <ClientPage>
      <PartnerList kind="customer" />
    </ClientPage>
  );
}
