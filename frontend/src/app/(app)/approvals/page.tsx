import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ApprovalsView } from "./approvals-view";

export const metadata: Metadata = { title: "Approvals" };

export default function Page() {
  return (
    <ClientPage>
      <ApprovalsView />
    </ClientPage>
  );
}
