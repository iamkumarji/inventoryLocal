import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ExpensesView } from "./expenses-view";

export const metadata: Metadata = { title: "Expense claims" };

export default function Page() {
  return (
    <ClientPage>
      <ExpensesView />
    </ClientPage>
  );
}
