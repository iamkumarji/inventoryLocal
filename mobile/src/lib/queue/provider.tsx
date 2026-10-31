import * as Network from "expo-network";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";

import { newId } from "../ids";
import { forgetPhoto } from "../keep-photo";
import { drain, newJob, prune, retry, type Job, type Step } from "./core";
import { httpSender } from "./sender";
import { createStore } from "./store";

type QueueValue = {
  jobs: Job[];
  waiting: number;
  failed: number;
  enqueue: (kind: string, label: string, steps: Omit<Step, "idempotencyKey">[]) => Promise<Job>;
  flush: () => Promise<void>;
  retry: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
};

const QueueContext = createContext<QueueValue | null>(null);

export function useQueue(): QueueValue {
  const value = useContext(QueueContext);
  if (!value) throw new Error("useQueue outside QueueProvider");
  return value;
}

const TICK_MS = 15_000;
const DAY_MS = 24 * 60 * 60_000;

export function QueueProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const store = useRef(createStore()).current;
  const [jobs, setJobs] = useState<Job[]>([]);
  const busy = useRef(false);

  const refresh = useCallback(async () => setJobs(await store.all()), [store]);

  const flush = useCallback(async () => {
    if (busy.current || !enabled) return;
    busy.current = true;
    try {
      await drain(store, httpSender);
      for (const job of await store.all()) {
        if (job.status !== "done") continue;
        for (const step of job.steps) if (step.body?.kind === "file") forgetPhoto(step.body.file.uri);
      }
      await prune(store, DAY_MS);
    } finally {
      busy.current = false;
      await refresh();
    }
  }, [enabled, refresh, store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    void flush();
    const timer = setInterval(() => void flush(), TICK_MS);
    const app = AppState.addEventListener("change", (s) => s === "active" && void flush());
    const net = Network.addNetworkStateListener((s) => s.isInternetReachable !== false && s.isConnected && void flush());
    return () => {
      clearInterval(timer);
      app.remove();
      net.remove();
    };
  }, [enabled, flush]);

  const value = useMemo<QueueValue>(
    () => ({
      jobs,
      waiting: jobs.filter((j) => j.status === "pending" || j.status === "running").length,
      failed: jobs.filter((j) => j.status === "failed").length,
      enqueue: async (kind, label, steps) => {
        const job = newJob(kind, label, steps, newId);
        await store.put(job);
        await refresh();
        void flush();
        return job;
      },
      flush,
      retry: async (id) => {
        await retry(store, id, newId);
        await flush();
      },
      discard: async (id) => {
        await store.remove(id);
        await refresh();
      },
    }),
    [flush, jobs, refresh, store],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}
