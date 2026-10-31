import { View } from "react-native";

import { Body, Button, Empty, Heading, Notice, Pill, Row, Screen } from "@/components/ui";
import type { Job } from "@/lib/queue/core";
import { useQueue } from "@/lib/queue/provider";

const TONE: Record<Job["status"], "ok" | "warn" | "danger" | "info"> = { done: "ok", pending: "warn", running: "info", failed: "danger" };
const LABEL: Record<Job["status"], string> = { done: "Sent", pending: "Waiting", running: "Sending", failed: "Refused" };

export default function Outbox() {
  const { jobs, flush, retry, discard, waiting } = useQueue();
  const sorted = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Screen>
      <Heading sub="Work saved on this phone and its delivery to the server">Outbox</Heading>
      {waiting ? <Button testID="send-now" title="Send now" onPress={flush} /> : null}
      {sorted.length === 0 ? <Empty>Nothing has been queued on this phone.</Empty> : null}
      {sorted.map((job) => (
        <View key={job.id} style={{ gap: 8 }} testID={`job-${job.status}`}>
          <Row
            title={job.label}
            detail={`${new Date(job.createdAt).toLocaleString()} · step ${Math.min(job.results.length + 1, job.steps.length)} of ${job.steps.length}`}
            right={<Pill tone={TONE[job.status]}>{LABEL[job.status]}</Pill>}
          />
          {job.error && job.status !== "done" ? (
            <Notice tone={job.status === "failed" ? "danger" : "warn"}>{[job.error.title, job.error.detail].filter(Boolean).join(" — ")}</Notice>
          ) : null}
          {job.status === "failed" ? (
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Button title="Try again" kind="secondary" onPress={() => retry(job.id)} />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Discard" kind="danger" onPress={() => discard(job.id)} />
              </View>
            </View>
          ) : null}
          {job.status === "done" ? <Body muted>Kept here for a day as a record.</Body> : null}
        </View>
      ))}
    </Screen>
  );
}
