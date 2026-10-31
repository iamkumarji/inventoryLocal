import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { LimitsView } from "./limits-view";

export const metadata: Metadata = { title: "Approval limits" };

export default function Page() {
  return (
    <ClientPage>
      <LimitsView />
    </ClientPage>
  );
}
