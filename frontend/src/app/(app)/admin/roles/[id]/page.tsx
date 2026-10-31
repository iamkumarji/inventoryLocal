import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { RoleDetail } from "./role-detail";

export const metadata: Metadata = { title: "Role" };

export default function Page() {
  return (
    <ClientPage>
      <RoleDetail />
    </ClientPage>
  );
}
