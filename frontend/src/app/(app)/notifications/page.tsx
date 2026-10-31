import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { NotificationsView } from "./notifications-view";

export const metadata: Metadata = { title: "Notifications" };

export default function Page() {
  return <ClientPage><NotificationsView /></ClientPage>;
}
