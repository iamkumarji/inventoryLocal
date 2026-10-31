import { router } from "expo-router";

import { api, unwrap } from "@/api/client";
import { Empty, Heading, Loading, Notice, Row, Screen } from "@/components/ui";
import { useLoad } from "@/lib/use-load";

type Count = { id: string; number: string; count_date: string; blind: boolean; warehouse: string; lines: unknown[] };

export default function Counts() {
  const { data, error, loading } = useLoad(async () => {
    const page = await unwrap(api.GET("/api/v1/inventory/counts/", { params: { query: { status: "counting", page_size: 100 } } }));
    return (page.results ?? []) as unknown as Count[];
  }, []);
  return (
    <Screen>
      <Heading sub="Counts open for entry in your warehouses">Stock counts</Heading>
      {loading ? <Loading /> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {data?.length === 0 ? <Empty>No counts are open.</Empty> : null}
      {data?.map((c) => (
        <Row
          key={c.id}
          testID={`count-${c.number}`}
          title={c.number}
          detail={`${c.count_date} · ${c.lines.length} ${c.lines.length === 1 ? "line" : "lines"}${c.blind ? " · blind" : ""}`}
          onPress={() => router.push({ pathname: "/count/[id]", params: { id: c.id } })}
        />
      ))}
    </Screen>
  );
}
