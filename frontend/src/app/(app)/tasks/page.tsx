import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { MyTasksView } from "./my-tasks-view";

export const metadata: Metadata = { title: "My tasks" };

export default function Page() {
  return (
    <ClientPage>
      <MyTasksView />
    </ClientPage>
  );
}
