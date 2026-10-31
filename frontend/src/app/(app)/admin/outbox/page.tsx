import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { OutboxView } from "./outbox-view";

export const metadata: Metadata = { title: "Event outbox" };

export default function Page() {
  return (
    <ClientPage>
      <OutboxView />
    </ClientPage>
  );
}
