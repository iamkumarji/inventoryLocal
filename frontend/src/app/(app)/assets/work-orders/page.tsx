"use client";

import { ForwardTo } from "@/components/production/redirect";

export default function Page() {
  return <ForwardTo to={() => "/assets/maintenance"} />;
}
