import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { MyPayslipsView } from "./my-payslips-view";

export const metadata: Metadata = { title: "My payslips" };

export default function Page() {
  return (
    <ClientPage>
      <MyPayslipsView />
    </ClientPage>
  );
}
