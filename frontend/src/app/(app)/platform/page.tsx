import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { PlatformView } from "./platform-view";

export const metadata: Metadata = { title: "Organizations" };

export default function Page() {
  return (
    <ClientPage>
      <PlatformView />
    </ClientPage>
  );
}
