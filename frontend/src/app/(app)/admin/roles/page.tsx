import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { RolesView } from "./roles-view";

export const metadata: Metadata = { title: "Roles" };

export default function Page() {
  return (
    <ClientPage>
      <RolesView />
    </ClientPage>
  );
}
