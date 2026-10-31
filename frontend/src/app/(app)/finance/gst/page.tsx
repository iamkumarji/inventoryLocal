import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { GstView } from "./gst-view";

export const metadata: Metadata = { title: "GST" };

export default function Page() {
  return (
    <ClientPage>
      <GstView />
    </ClientPage>
  );
}
