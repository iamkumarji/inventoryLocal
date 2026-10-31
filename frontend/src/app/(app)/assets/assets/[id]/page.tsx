"use client";

import { ForwardTo } from "@/components/production/redirect";

/** Approval requests link capitalizations to /assets/assets/{id}. */
export default function Page() {
  return <ForwardTo to={(id) => `/assets/${id}`} />;
}
