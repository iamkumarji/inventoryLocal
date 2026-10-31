import { useState } from "react";
import { View } from "react-native";

import { api, unwrap } from "@/api/client";
import { Body, Button, Empty, Heading, Loading, Notice, Row, Screen } from "@/components/ui";
import { receiveTransfer, today } from "@/lib/operations";
import { qty } from "@/lib/format";
import { useQueue } from "@/lib/queue/provider";
import { useLoad } from "@/lib/use-load";

type Transfer = { id: string; number: string; version: number; dispatched_on: string | null; lines: { id: string; item_code: string; quantity: string }[] };

export default function Transfers() {
  const { enqueue, jobs } = useQueue();
  const [done, setDone] = useState<Set<string>>(new Set());
  const { data, error, loading } = useLoad(async () => {
    const page = await unwrap(api.GET("/api/v1/inventory/transfers/", { params: { query: { status: "dispatched", page_size: 100 } } }));
    return (page.results ?? []) as unknown as Transfer[];
  }, []);
  const queued = new Set(jobs.filter((j) => j.kind === "transfer_receive" && j.status !== "failed").map((j) => j.label));

  return (
    <Screen>
      <Heading sub="Stock dispatched to warehouses you can receive into">Incoming transfers</Heading>
      {loading ? <Loading /> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {data?.length === 0 ? <Empty>Nothing is in transit to you.</Empty> : null}
      {data?.map((t) => {
        const label = `Receive transfer ${t.number}`;
        const pending = done.has(t.id) || queued.has(label);
        return (
          <View key={t.id} style={{ gap: 8 }}>
            <Row title={t.number} detail={`Dispatched ${t.dispatched_on ?? "—"} · ${t.lines.map((l) => `${l.item_code} × ${qty(l.quantity)}`).join(", ")}`} />
            <Button
              testID={`receive-${t.number}`}
              title={pending ? "Receipt queued" : "Received in full"}
              disabled={pending}
              onPress={async () => {
                await enqueue("transfer_receive", label, receiveTransfer(t.id, t.version, today()));
                setDone((s) => new Set(s).add(t.id));
              }}
            />
          </View>
        );
      })}
      <Body muted>Only confirm when everything on the transfer has arrived; report shortages to the sending warehouse.</Body>
    </Screen>
  );
}
