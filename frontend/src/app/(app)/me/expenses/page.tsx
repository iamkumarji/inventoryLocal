import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { MyExpensesView } from "./my-expenses-view";

export const metadata: Metadata = { title: "My expenses" };

export default function Page() {
  return (
    <ClientPage>
      <MyExpensesView />
    </ClientPage>
  );
}
