import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { PoliciesView } from "./policies-view";

export const metadata: Metadata = { title: "Policies" };

export default function Page() {
  return (
    <ClientPage>
      <PoliciesView />
    </ClientPage>
  );
}
