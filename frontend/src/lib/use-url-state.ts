"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

/** Filters, tabs and pages live in the URL so views can be shared and survive reloads. */
export function useUrlState() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // The query we last asked for but the router hasn't committed yet: a second change made before the
  // first navigation lands builds on it, so quick consecutive filter changes don't undo each other.
  const pending = useRef<string | null>(null);
  const current = params.toString();

  useEffect(() => {
    pending.current = null; // the URL caught up
  }, [current]);

  const set = useCallback(
    (updates: Record<string, string | number | null | undefined>) => {
      const next = new URLSearchParams(pending.current ?? current);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined || value === "") next.delete(key);
        else next.set(key, String(value));
      }
      if (!("page" in updates)) next.delete("page");
      const query = next.toString();
      pending.current = query;
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [current, pathname, router],
  );

  return { get: (key: string) => params.get(key) ?? "", page: Number(params.get("page") ?? "1") || 1, set };
}
