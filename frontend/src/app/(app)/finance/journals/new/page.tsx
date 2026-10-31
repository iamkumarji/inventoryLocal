import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { NewJournal } from "./new-journal";

export const metadata: Metadata = { title: "New journal" };

export default function Page() {
  return (
    <ClientPage>
      <NewJournal />
    </ClientPage>
  );
}
