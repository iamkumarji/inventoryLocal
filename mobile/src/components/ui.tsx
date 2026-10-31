import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { usePalette } from "./theme";

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const c = usePalette();
  const body = <View style={styles.inner}>{children}</View>;
  return (
    <SafeAreaView edges={["bottom", "left", "right"]} style={[styles.screen, { backgroundColor: c.bg }]}>
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

export function Heading({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  const c = usePalette();
  return (
    <View style={{ gap: 4 }}>
      <Text accessibilityRole="header" style={[styles.h1, { color: c.ink }]}>
        {children}
      </Text>
      {sub ? <Text style={{ color: c.muted, fontSize: 15 }}>{sub}</Text> : null}
    </View>
  );
}

export function Label({ children }: { children: ReactNode }) {
  const c = usePalette();
  return <Text style={{ color: c.muted, fontSize: 13, fontWeight: "600" }}>{children}</Text>;
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const c = usePalette();
  return <Text style={{ color: muted ? c.muted : c.ink, fontSize: 16, lineHeight: 22 }}>{children}</Text>;
}

export function Button({
  title,
  onPress,
  kind = "primary",
  disabled,
  busy,
  testID,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}) {
  const c = usePalette();
  const bg = kind === "primary" ? c.accent : kind === "danger" ? c.danger : c.surface;
  const fg = kind === "primary" ? c.accentInk : kind === "danger" ? "#FFFFFF" : c.ink;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: kind === "secondary" ? c.line : bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontSize: 17, fontWeight: "700" }}>{title}</Text>}
    </Pressable>
  );
}

export function Input({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  const c = usePalette();
  return (
    <View style={{ gap: 6 }}>
      <Label>{label}</Label>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={c.muted}
        {...props}
        style={[styles.input, { color: c.ink, backgroundColor: c.surface, borderColor: error ? c.danger : c.line }]}
      />
      {error ? <Text style={{ color: c.danger, fontSize: 14 }}>{error}</Text> : null}
    </View>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "danger" | "ok" | "warn"; children: ReactNode }) {
  const c = usePalette();
  const color = { info: c.info, danger: c.danger, ok: c.ok, warn: c.warn }[tone];
  return (
    <View accessibilityRole="alert" style={[styles.notice, { borderLeftColor: color, backgroundColor: c.surface }]}>
      <Text style={{ color: c.ink, fontSize: 15, lineHeight: 21 }}>{children}</Text>
    </View>
  );
}

export function Row({ title, detail, right, onPress, testID }: { title: string; detail?: string; right?: ReactNode; onPress?: () => void; testID?: string }) {
  const c = usePalette();
  const content = (
    <View testID={onPress ? undefined : testID} style={[styles.row, { backgroundColor: c.surface, borderColor: c.line }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.ink, fontSize: 16, fontWeight: "600" }}>{title}</Text>
        {detail ? <Text style={{ color: c.muted, fontSize: 14 }}>{detail}</Text> : null}
      </View>
      {right}
    </View>
  );
  return onPress ? (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

export function Pill({ tone, children }: { tone: "ok" | "warn" | "danger" | "info" | "muted"; children: ReactNode }) {
  const c = usePalette();
  const color = { ok: c.ok, warn: c.warn, danger: c.danger, info: c.info, muted: c.muted }[tone];
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <Text style={{ color, fontSize: 13, fontWeight: "700" }}>{children}</Text>
    </View>
  );
}

export function Loading() {
  const c = usePalette();
  return <ActivityIndicator style={{ marginTop: 32 }} color={c.ink} />;
}

export function Empty({ children }: { children: ReactNode }) {
  const c = usePalette();
  return <Text style={{ color: c.muted, fontSize: 15, textAlign: "center", marginTop: 24 }}>{children}</Text>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1 },
  inner: { padding: 16, gap: 16, width: "100%", maxWidth: 640, alignSelf: "center" },
  h1: { fontSize: 26, fontWeight: "800", letterSpacing: -0.3 },
  button: { minHeight: 52, borderRadius: 6, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  input: { minHeight: 50, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, fontSize: 17 },
  notice: { borderLeftWidth: 4, padding: 12, borderRadius: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderWidth: 1, borderRadius: 6 },
  pill: { borderWidth: 1.5, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 },
});
