import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { LeaveView } from "./leave-view";

export const metadata: Metadata = { title: "Leave" };

export default function Page() {
  return (
    <ClientPage>
      <LeaveView />
    </ClientPage>
  );
}
