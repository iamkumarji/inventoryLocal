import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { AttendanceView } from "./attendance-view";

export const metadata: Metadata = { title: "Attendance" };

export default function Page() {
  return (
    <ClientPage>
      <AttendanceView />
    </ClientPage>
  );
}
