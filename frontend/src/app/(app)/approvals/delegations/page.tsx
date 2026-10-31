import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { DelegationsView } from "./delegations-view";

export const metadata: Metadata = { title: "Delegations" };

export default function Page() {
  return <ClientPage><DelegationsView /></ClientPage>;
}
