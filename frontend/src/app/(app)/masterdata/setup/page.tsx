import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { SetupView } from "./setup-view";

export const metadata: Metadata = { title: "Item setup" };

export default function Page() {
  return (
    <ClientPage>
      <SetupView />
    </ClientPage>
  );
}
