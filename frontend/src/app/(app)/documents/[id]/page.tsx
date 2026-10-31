import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { DocumentDetail } from "./document-detail";

export const metadata: Metadata = { title: "Document" };

export default function Page() {
  return (
    <ClientPage>
      <DocumentDetail />
    </ClientPage>
  );
}
