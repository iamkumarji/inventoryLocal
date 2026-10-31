import * as Location from "expo-location";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { api, unwrap } from "@/api/client";
import { PhotoField } from "@/components/photo";
import { Body, Button, Heading, Input, Loading, Notice, Row, Screen } from "@/components/ui";
import { deliveryProof, type Photo } from "@/lib/operations";
import { useQueue } from "@/lib/queue/provider";
import { useLoad } from "@/lib/use-load";

type Shipment = { id: string; number: string; deliveries: string[]; proofs: { delivery: string; outcome: string }[] };
const OUTCOMES = [
  { value: "delivered", label: "Delivered in full" },
  { value: "partial", label: "Partly delivered" },
  { value: "refused", label: "Refused" },
] as const;

export default function Proof() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { enqueue, jobs } = useQueue();
  const { data: shipment, error, loading } = useLoad(
    async () => (await unwrap(api.GET("/api/v1/logistics/shipments/{id}/", { params: { path: { id } } }))) as unknown as Shipment,
    [id],
  );
  const [delivery, setDelivery] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number]["value"]>("delivered");
  const [receivedBy, setReceivedBy] = useState("");
  const [remarks, setRemarks] = useState("");
  const [note, setNote] = useState<Photo | null>(null);
  const [locating, setLocating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const recorded = new Set(shipment?.proofs.map((p) => p.delivery) ?? []);
  const queued = new Set(jobs.filter((j) => j.kind === "delivery_proof" && j.status !== "failed").map((j) => j.label));
  const label = (d: string) => `Proof for ${shipment?.number} / ${d.slice(0, 8)}`;
  // The server requires the signed note for a completed delivery; refusals need a reason instead.
  const needsNote = outcome !== "refused";
  const ready = delivery && receivedBy.trim() && (!needsNote || note) && (outcome !== "refused" || remarks.trim());

  const save = async () => {
    if (!shipment || !delivery || !ready) return;
    setLocating(true);
    let latitude: string | null = null;
    let longitude: string | null = null;
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.granted) {
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        latitude = pos.coords.latitude.toFixed(6);
        longitude = pos.coords.longitude.toFixed(6);
      }
    } catch {
      setMessage("Location unavailable; the proof is saved without it.");
    } finally {
      setLocating(false);
    }
    await enqueue(
      "delivery_proof",
      label(delivery),
      deliveryProof({
        shipment: shipment.id,
        delivery,
        outcome,
        receivedBy: receivedBy.trim(),
        receivedAt: new Date().toISOString(),
        signedNote: needsNote ? note : null,
        latitude,
        longitude,
        remarks: remarks.trim(),
      }),
    );
    router.replace("/queue");
  };

  if (loading) return <Loading />;
  if (error || !shipment) return <Screen><Notice tone="danger">{error ?? "Not found."}</Notice></Screen>;
  return (
    <Screen>
      <Heading sub="Choose the delivery you are handing over">{shipment.number}</Heading>
      <View style={{ gap: 8 }}>
        {shipment.deliveries.map((d, i) => {
          const done = recorded.has(d) || queued.has(label(d));
          return (
            <Row
              key={d}
              testID={`delivery-${i + 1}`}
              title={`Delivery ${i + 1} of ${shipment.deliveries.length}`}
              detail={done ? "Proof recorded" : delivery === d ? "Selected" : "Tap to select"}
              onPress={done ? undefined : () => setDelivery(d)}
            />
          );
        })}
      </View>
      {delivery ? (
        <>
          <View style={{ gap: 8 }}>
            {OUTCOMES.map((o) => (
              <Button key={o.value} testID={`outcome-${o.value}`} title={o.label} kind={outcome === o.value ? "primary" : "secondary"} onPress={() => setOutcome(o.value)} />
            ))}
          </View>
          <Input testID="received-by" label="Received by (name)" value={receivedBy} onChangeText={setReceivedBy} />
          {needsNote ? <PhotoField testID="signed-note" label="Photo of the signed delivery note" value={note} onChange={setNote} /> : null}
          <Input testID="remarks" label={outcome === "refused" ? "Reason for refusal" : "Remarks"} value={remarks} onChangeText={setRemarks} multiline />
          {message ? <Notice tone="warn">{message}</Notice> : null}
          <Button testID="save-proof" title="Save proof of delivery" onPress={save} busy={locating} disabled={!ready} />
          <Body muted>Location is attached when you allow it. The proof is stored on the phone until it reaches the server.</Body>
        </>
      ) : null}
    </Screen>
  );
}
