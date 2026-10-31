"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";

type StreamMessage =
  | { type: "notification.created"; id: string; title: string; category: string; link: string; unread_count: number }
  | { type: "notification.read"; unread_count: number }
  | { type: "pong" };

function streamUrl(): string {
  const base = process.env.NEXT_PUBLIC_WS_URL;
  if (base) return `${base.replace(/\/$/, "")}/ws/v1/stream/`;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/ws/v1/stream/`;
}

/** Live notification stream. Messages are hints; data is always refetched over REST. */
export function useRealtime(onNavigate: (href: string) => void) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      socket = new WebSocket(streamUrl());
      socket.onopen = () => {
        retry = 0;
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as StreamMessage;
        if (message.type === "notification.created" || message.type === "notification.read") {
          queryClient.setQueryData(["notifications", "unread"], { unread_count: message.unread_count });
          queryClient.invalidateQueries({ queryKey: ["notifications", "list"] });
        }
        if (message.type === "notification.created") {
          if (message.category === "approval") queryClient.invalidateQueries({ queryKey: ["approvals"] });
          toast(message.title, {
            action: message.link ? { label: "Open", onClick: () => onNavigate(message.link) } : undefined,
          });
        }
      };
      socket.onclose = (event) => {
        if (closed || event.code === 4401) return; // 4401: not authenticated, don't hammer the server
        retry += 1;
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry));
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [queryClient, onNavigate]);
}
