import { Redirect, router, type Href } from "expo-router";
import { View } from "react-native";

import { Body, Button, Heading, Loading, Notice, Row, Screen } from "@/components/ui";
import { useQueue } from "@/lib/queue/provider";
import { useSession } from "@/lib/session";

type Tile = { href: Href; title: string; detail: string; flag: string; anyOf: string[] };

// Shown by permission and module flag; the server enforces every action regardless.
const TILES: Tile[] = [
  { href: "/lookup", title: "Stock lookup", detail: "Scan an item, batch, serial or bin", flag: "module.inventory", anyOf: ["inventory.stock_balance.read"] },
  { href: "/receive", title: "Receive goods", detail: "Goods receipt against a purchase order", flag: "module.procurement", anyOf: ["procurement.goods_receipt.create"] },
  { href: "/count", title: "Stock counts", detail: "Enter counted quantities", flag: "module.inventory", anyOf: ["inventory.stock_count.update"] },
  { href: "/transfers", title: "Incoming transfers", detail: "Receive stock sent to your warehouse", flag: "module.inventory", anyOf: ["inventory.stock_transfer.receive"] },
  { href: "/deliveries", title: "My deliveries", detail: "Proof of delivery with photo and location", flag: "module.logistics", anyOf: ["logistics.shipment.deliver"] },
  { href: "/approvals", title: "Approvals", detail: "Requests waiting for your decision", flag: "", anyOf: [] },
  { href: "/expense", title: "New expense", detail: "Claim with a receipt photo", flag: "module.expenses", anyOf: ["expenses.expense_claim.create"] },
];

export default function Home() {
  const { state, me, canAny, flag, logout, switchCompany } = useSession();
  const { waiting, failed } = useQueue();
  if (state.status === "loading") return <Loading />;
  if (state.status === "signed_out" || !me) return <Redirect href="/login" />;
  const tiles = TILES.filter((t) => (!t.flag || flag(t.flag)) && canAny(t.anyOf));
  const company = me.companies.find((x) => x.id === me.active_company_id);
  return (
    <Screen>
      <Heading sub={company ? `${company.code} · ${company.name}` : undefined}>{me.user.full_name}</Heading>
      {failed ? <Notice tone="danger">{failed} queued action(s) were refused by the server. Open the outbox to see why.</Notice> : null}
      {waiting ? <Notice tone="warn">{waiting} action(s) waiting to send. They go automatically when the connection is back.</Notice> : null}
      <View style={{ gap: 10 }}>
        {tiles.map((t) => (
          <Row key={String(t.href)} testID={`tile-${String(t.href).slice(1)}`} title={t.title} detail={t.detail} onPress={() => router.push(t.href)} />
        ))}
        {tiles.length === 0 ? <Body muted>No mobile tasks are enabled for your role. Ask your administrator.</Body> : null}
      </View>
      {me.companies.length > 1 ? (
        <View style={{ gap: 8 }}>
          <Body muted>Company</Body>
          {me.companies.map((x) => (
            <Row key={x.id} title={x.code} detail={x.name} right={x.id === me.active_company_id ? <Body>✓</Body> : null} onPress={() => switchCompany(x.id)} />
          ))}
        </View>
      ) : null}
      <Button title="Outbox" kind="secondary" onPress={() => router.push("/queue")} />
      <Button title="Sign out" kind="secondary" onPress={logout} testID="sign-out" />
    </Screen>
  );
}
