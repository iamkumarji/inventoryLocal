import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { JournalsView } from "./journals-view";

export const metadata: Metadata = { title: "Journals" };

export default function Page() {
  return (
    <ClientPage>
      <JournalsView />
    </ClientPage>
  );
}
