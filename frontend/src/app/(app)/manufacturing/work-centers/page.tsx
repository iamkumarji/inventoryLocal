import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { WorkCentersView } from "./work-centers-view";

export const metadata: Metadata = { title: "Work centres" };

export default function Page() {
  return (
    <ClientPage>
      <WorkCentersView />
    </ClientPage>
  );
}
