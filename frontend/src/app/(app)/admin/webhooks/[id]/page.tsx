import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { WebhookDetail } from "./webhook-detail";

export const metadata: Metadata = { title: "Webhook endpoint" };

export default function Page() {
  return (
    <ClientPage>
      <WebhookDetail />
    </ClientPage>
  );
}
