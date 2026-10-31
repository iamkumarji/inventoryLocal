import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { DepreciationView } from "./depreciation-view";

export const metadata: Metadata = { title: "Depreciation" };

export default function Page() {
  return (
    <ClientPage>
      <DepreciationView />
    </ClientPage>
  );
}
