import { Suspense, type ReactNode } from "react";

import { PageSkeleton } from "./states";

/** Client pages read URL state; Suspense keeps the static shell prerenderable. */
export function ClientPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}
