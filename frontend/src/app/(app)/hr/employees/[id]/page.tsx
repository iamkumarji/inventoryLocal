import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { EmployeeDetail } from "./employee-detail";

export const metadata: Metadata = { title: "Employee" };

export default function Page() {
  return (
    <ClientPage>
      <EmployeeDetail />
    </ClientPage>
  );
}
