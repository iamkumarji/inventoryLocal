import type { Metadata } from "next";

import { ClientPage } from "@/components/erp/page";

import { ForecastView } from "./forecast-view";

export const metadata: Metadata = { title: "Demand forecast" };

export default function Page() {
  return (
    <ClientPage>
      <ForecastView />
    </ClientPage>
  );
}
