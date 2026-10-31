import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { api, unwrap } from "@/api/client";
import { CodeEntry } from "@/components/scanner";
import { Body, Button, Heading, Input, Loading, Notice, Screen } from "@/components/ui";
import { isQuantity, recordCount } from "@/lib/operations";
import { qty as fmtQty } from "@/lib/format";
import { useQueue } from "@/lib/queue/provider";
import { useLoad } from "@/lib/use-load";

// system_quantity is omitted by the API on blind counts for people who only count.
type Line = { id: string; item: string; item_code: string; item_name: string; system_quantity?: string | null; counted_quantity: string | null };
type Count = { id: string; number: string; blind: boolean; lines: Line[] };

export default function CountEntry() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { enqueue } = useQueue();
  const { data: count, error, loading } = useLoad(async () => (await unwrap(api.GET("/api/v1/inventory/counts/{id}/", { params: { path: { id } } }))) as unknown as Count, [id]);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const entered = (count?.lines ?? []).filter((l) => qty[l.id]?.trim());
  const invalid = entered.filter((l) => !isQuantity(qty[l.id], true));

  const onScan = async (code: string) => {
    setMessage(null);
    try {
      const hit = (await unwrap(api.GET("/api/v1/inventory/scan/", { params: { query: { code } } }))) as unknown as { item_id?: string };
      const line = count?.lines.find((l) => l.item === hit.item_id);
      if (line) setFocus(line.id);
      else setMessage("That item isn't on this count. Tell your supervisor so it can be added.");
    } catch {
      setMessage("Code not recognised.");
    }
  };

  const save = async () => {
    if (!count || !entered.length || invalid.length) return;
    await enqueue("stock_count", `Count entries for ${count.number}`, recordCount(count.id, entered.map((l) => ({ line_id: l.id, counted_quantity: qty[l.id].trim() }))));
    router.replace("/queue");
  };

  if (loading) return <Loading />;
  if (error || !count) return <Screen><Notice tone="danger">{error ?? "Not found."}</Notice></Screen>;
  return (
    <Screen>
      <Heading sub={count.blind ? "Blind count: count what is there" : undefined}>{count.number}</Heading>
      <CodeEntry label="Scan an item to jump to its line" onCode={onScan} />
      {message ? <Notice tone="warn">{message}</Notice> : null}
      {count.lines.map((l) => (
        <View key={l.id} style={{ gap: 6, padding: 10, borderRadius: 6, borderWidth: focus === l.id ? 2 : 0, borderColor: "#F5C400" }}>
          <Body>{`${l.item_code} — ${l.item_name}`}</Body>
          {l.system_quantity != null ? <Body muted>{`System: ${fmtQty(l.system_quantity)}`}</Body> : null}
          <Input
            testID={`count-${l.item_code}`}
            label={l.counted_quantity != null ? `Counted (last entry ${fmtQty(l.counted_quantity)})` : "Counted"}
            value={qty[l.id] ?? ""}
            onChangeText={(v) => setQty((q) => ({ ...q, [l.id]: v }))}
            keyboardType="decimal-pad"
            autoFocus={focus === l.id}
            error={qty[l.id]?.trim() && !isQuantity(qty[l.id], true) ? "Enter zero or a positive number." : undefined}
          />
        </View>
      ))}
      <Button testID="save-count" title={`Save ${entered.length} entr${entered.length === 1 ? "y" : "ies"}`} onPress={save} disabled={!entered.length || invalid.length > 0} />
    </Screen>
  );
}
