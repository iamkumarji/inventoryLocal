import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { LeaveRequestDetail } from "./leave-request-detail";

export const metadata: Metadata = { title: "Leave request" };

export default function Page() {
  return (
    <ClientPage>
      <LeaveRequestDetail />
    </ClientPage>
  );
}
