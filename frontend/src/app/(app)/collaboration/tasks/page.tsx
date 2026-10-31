import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { TasksView } from "./tasks-view";

export const metadata: Metadata = { title: "Tasks" };

export default function Page() {
  return (
    <ClientPage>
      <TasksView />
    </ClientPage>
  );
}
