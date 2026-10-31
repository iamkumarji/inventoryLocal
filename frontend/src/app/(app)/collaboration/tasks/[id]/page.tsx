import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { TaskDetail } from "./task-detail";

export const metadata: Metadata = { title: "Task" };

export default function Page() {
  return (
    <ClientPage>
      <TaskDetail />
    </ClientPage>
  );
}
