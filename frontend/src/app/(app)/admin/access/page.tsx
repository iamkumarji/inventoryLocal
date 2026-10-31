import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { AccessView } from "./access-view";

export const metadata: Metadata = { title: "Access grants" };

export default function Page() {
  return (
    <ClientPage>
      <AccessView />
    </ClientPage>
  );
}
