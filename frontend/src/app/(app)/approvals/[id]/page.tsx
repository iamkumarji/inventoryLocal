import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { RequestDetail } from "./request-detail";

export const metadata: Metadata = { title: "Approval request" };

export default function Page() {
  return (
    <ClientPage>
      <RequestDetail />
    </ClientPage>
  );
}
