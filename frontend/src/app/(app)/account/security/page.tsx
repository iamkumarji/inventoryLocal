import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { SecurityView } from "./security-view";

export const metadata: Metadata = { title: "Account security" };

export default function Page() {
  return <ClientPage><SecurityView /></ClientPage>;
}
