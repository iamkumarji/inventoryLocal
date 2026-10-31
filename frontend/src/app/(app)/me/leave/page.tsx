import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { MyLeaveView } from "./my-leave-view";

export const metadata: Metadata = { title: "My leave" };

export default function Page() {
  return (
    <ClientPage>
      <MyLeaveView />
    </ClientPage>
  );
}
