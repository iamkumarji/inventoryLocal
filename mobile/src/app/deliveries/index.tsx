import { router } from "expo-router";

import { api, unwrap } from "@/api/client";
import { Empty, Heading, Loading, Notice, Row, Screen } from "@/components/ui";
import { useLoad } from "@/lib/use-load";

type Shipment = { id: string; number: string; planned_date: string; deliveries: string[]; proofs: { delivery: string }[] };

export default function Deliveries() {
  const { data, error, loading } = useLoad(async () => {
    // Partly delivered shipments are still on the road.
    const pages = await Promise.all(
      (["dispatched", "partially_delivered"] as const).map((status) => unwrap(api.GET("/api/v1/logistics/shipments/", { params: { query: { status, page_size: 50 } } }))),
    );
    return pages.flatMap((p) => (p.results ?? []) as unknown as Shipment[]);
  }, []);
  return (
    <Screen>
      <Heading sub="Dispatched shipments assigned to you">My deliveries</Heading>
      {loading ? <Loading /> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {data?.length === 0 ? <Empty>No shipments are out for delivery.</Empty> : null}
      {data?.map((s) => (
        <Row
          key={s.id}
          testID={`shipment-${s.number}`}
          title={s.number}
          detail={`${s.planned_date} · ${s.proofs.length}/${s.deliveries.length} delivered`}
          onPress={() => router.push({ pathname: "/deliveries/[id]", params: { id: s.id } })}
        />
      ))}
    </Screen>
  );
}
