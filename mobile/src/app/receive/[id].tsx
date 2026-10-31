import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { api, unwrap } from "@/api/client";
import { CodeEntry } from "@/components/scanner";
import { Body, Button, Heading, Input, Loading, Notice, Screen } from "@/components/ui";
import { isQuantity, receiveGoods, today } from "@/lib/operations";
import { useQueue } from "@/lib/queue/provider";
import { useLoad } from "@/lib/use-load";

type PoLine = { id: string; line_no: number; item: string; item_code: string; item_name: string; quantity: string; received_quantity: string; returned_quantity: string; warehouse: string; uom: string };
type Po = { id: string; number: string; supplier_name: string; lines: PoLine[] };

/** Outstanding = ordered − received + returned, shown as text; the server applies tolerance and UoM rules. */
function outstanding(line: PoLine): string {
  const scale = 1_000_000n;
  const toInt = (v: string) => {
    const [w, f = ""] = v.split(".");
    return BigInt(w) * scale + BigInt((f + "000000").slice(0, 6));
  };
  const n = toInt(line.quantity) - toInt(line.received_quantity) + toInt(line.returned_quantity);
  if (n <= 0n) return "0";
  const whole = n / scale;
  const frac = (n % scale).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export default function Receipt() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { enqueue } = useQueue();
  const { data: po, error, loading } = useLoad(async () => (await unwrap(api.GET("/api/v1/procurement/orders/{id}/", { params: { path: { id } } }))) as unknown as Po, [id]);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const open = useMemo(() => (po?.lines ?? []).filter((l) => outstanding(l) !== "0"), [po]);
  const entered = open.filter((l) => qty[l.id]?.trim());
  const invalid = entered.filter((l) => !isQuantity(qty[l.id]));
  const warehouses = new Set(entered.map((l) => l.warehouse));

  const onScan = async (code: string) => {
    setMessage(null);
    try {
      const hit = (await unwrap(api.GET("/api/v1/inventory/scan/", { params: { query: { code } } }))) as unknown as { item_id?: string };
      const line = open.find((l) => l.item === hit.item_id);
      if (line) setFocus(line.id);
      else setMessage("That item isn't open on this order.");
    } catch {
      setMessage("Code not recognised.");
    }
  };

  const save = async () => {
    if (!po || !entered.length || invalid.length || warehouses.size !== 1) return;
    await enqueue(
      "goods_receipt",
      `Receipt for ${po.number}`,
      receiveGoods({
        purchaseOrder: po.id,
        warehouse: [...warehouses][0],
        receiptDate: today(),
        deliveryNote: note.trim(),
        vehicle: vehicle.trim(),
        lines: entered.map((l) => ({ po_line: l.id, quantity: qty[l.id].trim() })),
      }),
    );
    router.replace("/queue");
  };

  if (loading) return <Loading />;
  if (error || !po) return <Screen><Notice tone="danger">{error ?? "Not found."}</Notice></Screen>;
  return (
    <Screen>
      <Heading sub={po.supplier_name}>{po.number}</Heading>
      <CodeEntry label="Scan an item to jump to its line" onCode={onScan} />
      {message ? <Notice tone="warn">{message}</Notice> : null}
      {open.map((l) => (
        <View key={l.id} style={{ gap: 6, padding: 10, borderRadius: 6, borderWidth: focus === l.id ? 2 : 0, borderColor: "#F5C400" }}>
          <Body>{`${l.item_code} — ${l.item_name}`}</Body>
          <Input
            testID={`qty-${l.item_code}`}
            label={`Received now (open ${outstanding(l)})`}
            value={qty[l.id] ?? ""}
            onChangeText={(v) => setQty((q) => ({ ...q, [l.id]: v }))}
            keyboardType="decimal-pad"
            autoFocus={focus === l.id}
            error={qty[l.id]?.trim() && !isQuantity(qty[l.id]) ? "Enter a positive number (up to 6 decimals)." : undefined}
          />
        </View>
      ))}
      <Input label="Supplier delivery note" value={note} onChangeText={setNote} testID="delivery-note" />
      <Input label="Vehicle number" value={vehicle} onChangeText={setVehicle} autoCapitalize="characters" />
      {warehouses.size > 1 ? <Notice tone="warn">These lines go to different warehouses. Receive one warehouse at a time.</Notice> : null}
      <Button testID="save-receipt" title="Receive and post" onPress={save} disabled={!entered.length || invalid.length > 0 || warehouses.size !== 1} />
      <Body muted>Saved to the outbox first, so it is kept if the connection drops.</Body>
    </Screen>
  );
}
