import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { SessionGate } from "@/lib/session";

// Everything below renders only after the browser has a session, so Next can't prerender
// (or validate) these pages for instant navigation. Entering the signed-in area may block on
// the session; within it the shell persists and each page shows its own loading state.
export const instant = false;

function ShellSkeleton() {
  return (
    <div className="flex min-h-dvh" aria-busy="true" aria-label="Loading">
      <div className="hidden w-60 bg-sidebar lg:block" />
      <div className="flex-1 p-8">
        <Skeleton className="mb-8 h-9 w-80" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    // The skeleton is the prerendered shell; the session (and URL-dependent routing) streams in at runtime.
    <Suspense fallback={<ShellSkeleton />}>
      <SessionGate fallback={<ShellSkeleton />}>
        <AppShell>{children}</AppShell>
      </SessionGate>
    </Suspense>
  );
}
