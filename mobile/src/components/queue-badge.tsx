import { Link } from "expo-router";
import { Pressable, Text } from "react-native";

import { useQueue } from "@/lib/queue/provider";

import { usePalette } from "./theme";

/** Header indicator: how much is waiting to send or needs attention. */
export function QueueBadge() {
  const { waiting, failed } = useQueue();
  const c = usePalette();
  if (!waiting && !failed) return null;
  const color = failed ? c.danger : c.warn;
  return (
    <Link href="/queue" asChild>
      <Pressable testID="queue-badge" accessibilityRole="button" accessibilityLabel="Outbox" style={{ paddingHorizontal: 8 }}>
        <Text style={{ color, fontWeight: "800", fontSize: 15 }}>
          {failed ? `${failed} need attention` : `${waiting} to send`}
        </Text>
      </Pressable>
    </Link>
  );
}
