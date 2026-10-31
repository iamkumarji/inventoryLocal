import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { RunDetail } from "./run-detail";

export const metadata: Metadata = { title: "Depreciation run" };

export default function Page() {
  return (
    <ClientPage>
      <RunDetail />
    </ClientPage>
  );
}
