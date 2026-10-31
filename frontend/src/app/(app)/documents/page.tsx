import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { DocumentsView } from "./documents-view";

export const metadata: Metadata = { title: "Documents" };

export default function Page() {
  return (
    <ClientPage>
      <DocumentsView />
    </ClientPage>
  );
}
