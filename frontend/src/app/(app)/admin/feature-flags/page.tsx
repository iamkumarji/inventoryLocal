import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { FlagsView } from "./flags-view";

export const metadata: Metadata = { title: "Feature flags" };

export default function Page() {
  return (
    <ClientPage>
      <FlagsView />
    </ClientPage>
  );
}
