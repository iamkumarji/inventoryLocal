import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { RecordRedirect } from "./record-redirect";

export const metadata: Metadata = { title: "Opening record" };

export default function Page() {
  return (
    <ClientPage>
      <RecordRedirect />
    </ClientPage>
  );
}
