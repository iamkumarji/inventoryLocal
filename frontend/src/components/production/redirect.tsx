"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

import { PageSkeleton } from "@/components/erp/states";

/** Forwards links the API generates (approvals, notifications) to the screen that shows the record. */
export function ForwardTo({ to }: { to: (id: string | undefined) => string }) {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const target = to(params.id);
  useEffect(() => {
    router.replace(target);
  }, [router, target]);
  return <PageSkeleton />;
}
