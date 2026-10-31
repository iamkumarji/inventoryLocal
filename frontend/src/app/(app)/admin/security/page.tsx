import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { SecurityPolicyView } from "./security-policy-view";

export const metadata: Metadata = { title: "Sign-in security" };

export default function Page() {
  return (
    <ClientPage>
      <SecurityPolicyView />
    </ClientPage>
  );
}
