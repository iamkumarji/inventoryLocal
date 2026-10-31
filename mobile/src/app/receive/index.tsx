import { router } from "expo-router";

import { api, unwrap } from "@/api/client";
import { Body, Empty, Heading, Loading, Notice, Row, Screen } from "@/components/ui";
import { useLoad } from "@/lib/use-load";

type Po = { id: string; number: string; supplier_name: string; expected_date: string; receipt_status: string };

export default function OpenOrders() {
  const { data, error, loading } = useLoad(async () => {
    const page = await unwrap(api.GET("/api/v1/procurement/orders/", { params: { query: { status: "approved", page_size: 100 } } }));
    return ((page.results ?? []) as unknown as Po[]).filter((po) => po.receipt_status !== "received");
  }, []);
  return (
    <Screen>
      <Heading sub="Approved purchase orders still open for receipt">Receive goods</Heading>
      {loading ? <Loading /> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {data?.length === 0 ? <Empty>Nothing is waiting to be received.</Empty> : null}
      {data?.map((po) => (
        <Row
          key={po.id}
          testID={`po-${po.number}`}
          title={`${po.number} · ${po.supplier_name}`}
          detail={`Expected ${po.expected_date} · ${po.receipt_status.replace("_", " ")}`}
          onPress={() => router.push({ pathname: "/receive/[id]", params: { id: po.id } })}
        />
      ))}
      <Body muted>Receipts post to stock straight away; items that need inspection go to quality hold.</Body>
    </Screen>
  );
}
