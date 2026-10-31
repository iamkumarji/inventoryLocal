import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { WebhooksView } from "./webhooks-view";

export const metadata: Metadata = { title: "Webhooks" };

export default function Page() {
  return (
    <ClientPage>
      <WebhooksView />
    </ClientPage>
  );
}
