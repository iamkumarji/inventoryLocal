import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { OrganizationView } from "./organization-view";

export const metadata: Metadata = { title: "Organization" };

export default function Page() {
  return (
    <ClientPage>
      <OrganizationView />
    </ClientPage>
  );
}
