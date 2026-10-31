"use client";

import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api/client";

export function NotificationBell() {
  const { data } = useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: () => unwrap(api.GET("/api/v1/notifications/unread-count/")),
    refetchInterval: 120_000, // safety net if the WebSocket is down
  });
  const count = data?.unread_count ?? 0;
  return (
    <Button variant="ghost" size="icon" asChild className="relative">
      <Link href="/notifications" aria-label={count ? `Notifications, ${count} unread` : "Notifications"}>
        <Bell />
        {count > 0 && (
          <span className="num absolute top-1 right-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[0.65rem] font-semibold text-primary-foreground">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </Link>
    </Button>
  );
}
