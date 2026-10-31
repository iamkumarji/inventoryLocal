import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { JournalDetail } from "./journal-detail";

export const metadata: Metadata = { title: "Journal" };

export default function Page() {
  return (
    <ClientPage>
      <JournalDetail />
    </ClientPage>
  );
}
