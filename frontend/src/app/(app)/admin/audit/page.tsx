import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { AuditView } from "./audit-view";

export const metadata: Metadata = { title: "Audit log" };

export default function Page() {
  return (
    <ClientPage>
      <AuditView />
    </ClientPage>
  );
}
