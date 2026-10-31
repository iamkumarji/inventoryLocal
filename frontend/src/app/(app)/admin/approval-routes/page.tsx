import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { RoutesView } from "./routes-view";

export const metadata: Metadata = { title: "Approval routes" };

export default function Page() {
  return (
    <ClientPage>
      <RoutesView />
    </ClientPage>
  );
}
