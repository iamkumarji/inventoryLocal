import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { AssetsView } from "./assets-view";

export const metadata: Metadata = { title: "Fixed assets" };

export default function Page() {
  return (
    <ClientPage>
      <AssetsView />
    </ClientPage>
  );
}
