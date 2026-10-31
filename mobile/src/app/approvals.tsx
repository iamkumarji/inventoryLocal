import { useState } from "react";
import { View } from "react-native";

import { api, unwrap } from "@/api/client";
import { Body, Button, Empty, Heading, Input, Loading, Notice, Row, Screen } from "@/components/ui";
import { decideApproval } from "@/lib/operations";
import { useQueue } from "@/lib/queue/provider";
import { useLoad } from "@/lib/use-load";

type Request = { id: string; title: string; document_label: string; document_number: string; amount: string | null; currency: string; can_decide: boolean; version: number; current_step_name: string };

export default function Approvals() {
  const { enqueue, jobs } = useQueue();
  const [open, setOpen] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const { data, error, loading } = useLoad(async () => (await unwrap(api.GET("/api/v1/approvals/inbox/"))) as unknown as Request[], []);
  const queued = new Set(jobs.filter((j) => j.kind === "approval" && j.status !== "failed").map((j) => j.label.split(" ").pop()));

  const decide = async (r: Request, approve: boolean) => {
    await enqueue("approval", `${approve ? "Approve" : "Reject"} ${r.id}`, decideApproval(r.id, r.version, approve, comment.trim()));
    setOpen(null);
    setComment("");
  };

  return (
    <Screen>
      <Heading sub="Decisions are checked again on the server: limits, segregation of duties and your own requests">Approvals</Heading>
      {loading ? <Loading /> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {data?.length === 0 ? <Empty>Nothing is waiting for you.</Empty> : null}
      {data?.map((r) => (
        <View key={r.id} style={{ gap: 8 }}>
          <Row
            testID={`request-${r.document_number}`}
            title={r.title}
            detail={[r.document_label, r.document_number, r.amount ? `${r.currency} ${r.amount}` : null, r.current_step_name].filter(Boolean).join(" · ")}
            onPress={() => setOpen(open === r.id ? null : r.id)}
          />
          {queued.has(r.id) ? <Body muted>Decision queued.</Body> : null}
          {open === r.id && !queued.has(r.id) ? (
            r.can_decide ? (
              <View style={{ gap: 8 }}>
                <Input testID="decision-comment" label="Comment (required to reject)" value={comment} onChangeText={setComment} multiline />
                <Button testID="approve" title="Approve" onPress={() => decide(r, true)} />
                <Button testID="reject" title="Reject" kind="danger" disabled={!comment.trim()} onPress={() => decide(r, false)} />
              </View>
            ) : (
              <Notice>You can see this request but can’t decide it at this step.</Notice>
            )
          ) : null}
        </View>
      ))}
    </Screen>
  );
}
