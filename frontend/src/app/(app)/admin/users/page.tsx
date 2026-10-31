import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { UsersView } from "./users-view";

export const metadata: Metadata = { title: "Users" };

export default function Page() {
  return (
    <ClientPage>
      <UsersView />
    </ClientPage>
  );
}
