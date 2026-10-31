import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { QueueBadge } from "@/components/queue-badge";
import { usePalette } from "@/components/theme";
import { QueueProvider } from "@/lib/queue/provider";
import { SessionProvider, useSession } from "@/lib/session";

function Navigator() {
  const { state } = useSession();
  const c = usePalette();
  return (
    // Queued work only sends while signed in; it is kept on the device otherwise.
    <QueueProvider enabled={state.status === "signed_in"}>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.surface },
          headerTintColor: c.ink,
          headerTitleStyle: { fontWeight: "700" },
          contentStyle: { backgroundColor: c.bg },
          headerRight: () => <QueueBadge />,
        }}
      >
        <Stack.Screen name="index" options={{ title: "OtabuPro ERP" }} />
        <Stack.Screen name="login" options={{ title: "Sign in", headerRight: () => null }} />
        <Stack.Screen name="lookup" options={{ title: "Stock lookup" }} />
        <Stack.Screen name="receive/index" options={{ title: "Receive goods" }} />
        <Stack.Screen name="receive/[id]" options={{ title: "Goods receipt" }} />
        <Stack.Screen name="count/index" options={{ title: "Stock counts" }} />
        <Stack.Screen name="count/[id]" options={{ title: "Count" }} />
        <Stack.Screen name="transfers" options={{ title: "Incoming transfers" }} />
        <Stack.Screen name="deliveries/index" options={{ title: "My deliveries" }} />
        <Stack.Screen name="deliveries/[id]" options={{ title: "Proof of delivery" }} />
        <Stack.Screen name="approvals" options={{ title: "Approvals" }} />
        <Stack.Screen name="expense" options={{ title: "New expense" }} />
        <Stack.Screen name="queue" options={{ title: "Outbox" }} />
      </Stack>
    </QueueProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <Navigator />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
