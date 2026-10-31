import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { NewAdjustment } from "./new-adjustment";

export const metadata: Metadata = { title: "New stock adjustment" };

export default function Page() {
  return (
    <ClientPage>
      <NewAdjustment />
    </ClientPage>
  );
}
