import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { AssetDetail } from "./asset-detail";

export const metadata: Metadata = { title: "Fixed asset" };

export default function Page() {
  return (
    <ClientPage>
      <AssetDetail />
    </ClientPage>
  );
}
