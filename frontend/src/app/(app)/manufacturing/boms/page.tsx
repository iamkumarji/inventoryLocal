import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { BomsView } from "./boms-view";

export const metadata: Metadata = { title: "Bills of materials" };

export default function Page() {
  return (
    <ClientPage>
      <BomsView />
    </ClientPage>
  );
}
