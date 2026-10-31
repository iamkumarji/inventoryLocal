import { useState } from "react";
import { View } from "react-native";

import { api, messageOf, unwrap } from "@/api/client";
import { CodeEntry } from "@/components/scanner";
import { qty } from "@/lib/format";
import { Body, Heading, Loading, Notice, Pill, Row, Screen } from "@/components/ui";

type ScanHit = { kind: string; item_id?: string; item_code?: string; status?: string; expires_on?: string | null };
type Stock = { id: string; warehouse_code: string; quantity: string; reserved_quantity: string; uom: string };

export default function Lookup() {
  const [hit, setHit] = useState<ScanHit | null>(null);
  const [balances, setBalances] = useState<Stock[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const find = async (code: string) => {
    setBusy(true);
    setError(null);
    setHit(null);
    setBalances(null);
    try {
      const result = (await unwrap(api.GET("/api/v1/inventory/scan/", { params: { query: { code } } }))) as unknown as ScanHit;
      setHit(result);
      if (result.item_id) {
        const page = await unwrap(api.GET("/api/v1/inventory/stock/", { params: { query: { item: result.item_id, page_size: 100 } } }));
        setBalances((page.results ?? []) as unknown as Stock[]);
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Heading sub="Item barcode, batch, serial number or bin label">Stock lookup</Heading>
      <CodeEntry testID="lookup-code" label="Code" onCode={find} />
      {busy ? <Loading /> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {hit ? (
        <View style={{ gap: 10 }}>
          <Row
            title={hit.item_code ?? hit.kind}
            detail={[hit.kind, hit.status, hit.expires_on ? `expires ${hit.expires_on}` : null].filter(Boolean).join(" · ")}
          />
          {balances?.length === 0 ? <Body muted>No stock in the warehouses you can see.</Body> : null}
          {balances?.map((b) => (
            <Row
              key={b.id}
              testID={`stock-${b.warehouse_code}`}
              title={`${qty(b.quantity)} on hand`}
              detail={b.warehouse_code}
              right={qty(b.reserved_quantity) !== "0" ? <Pill tone="info">{`${qty(b.reserved_quantity)} reserved`}</Pill> : null}
            />
          ))}
        </View>
      ) : null}
    </Screen>
  );
}
