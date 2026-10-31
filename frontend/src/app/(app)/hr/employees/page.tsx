import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { EmployeesView } from "./employees-view";

export const metadata: Metadata = { title: "Employees" };

export default function Page() {
  return (
    <ClientPage>
      <EmployeesView />
    </ClientPage>
  );
}
