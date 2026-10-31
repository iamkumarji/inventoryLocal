import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { BudgetsView } from "./budgets-view";

export const metadata: Metadata = { title: "Budgets" };

export default function Page() {
  return (
    <ClientPage>
      <BudgetsView />
    </ClientPage>
  );
}
