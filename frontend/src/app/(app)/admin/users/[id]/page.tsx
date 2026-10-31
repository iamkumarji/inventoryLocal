import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { UserDetail } from "./user-detail";

export const metadata: Metadata = { title: "User" };

export default function Page() {
  return (
    <ClientPage>
      <UserDetail />
    </ClientPage>
  );
}
