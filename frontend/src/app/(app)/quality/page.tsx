import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { QualityView } from "./quality-view";

export const metadata: Metadata = { title: "Quality" };

export default function Page() {
  return (
    <ClientPage>
      <QualityView />
    </ClientPage>
  );
}
