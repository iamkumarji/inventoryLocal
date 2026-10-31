import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { SodView } from "./sod-view";

export const metadata: Metadata = { title: "Segregation of duties" };

export default function Page() {
  return (
    <ClientPage>
      <SodView />
    </ClientPage>
  );
}
