/**
 * Offline-tolerant operation queue (NFR-010).
 *
 * A job is one user action, made of ordered HTTP steps (e.g. "create goods receipt" then "post it").
 * Every step carries an Idempotency-Key generated when the job is queued, so a resend after a lost
 * response replays the server's stored result instead of acting twice. Later steps can reference
 * earlier responses ("{0.id}") because a replayed step returns the same body.
 *
 * The server stays authoritative: a business rejection (4xx) stops the job and shows the server's
 * message; nothing is retried or "fixed" locally. Only transport failures, 5xx, 408 and 429 retry.
 */

export type StepBody =
  | { kind: "json"; value: unknown }
  | { kind: "file"; fields: Record<string, string>; file: { field: string; uri: string; name: string; type: string } };

export type Step = {
  method: "POST" | "PATCH";
  /** May contain {<stepIndex>.<field>} placeholders resolved from earlier responses. */
  path: string;
  body?: StepBody;
  idempotencyKey: string;
};

export type JobStatus = "pending" | "running" | "done" | "failed";

export type Job = {
  id: string;
  kind: string;
  label: string;
  createdAt: string;
  status: JobStatus;
  steps: Step[];
  /** Responses of completed steps, by index. */
  results: unknown[];
  attempts: number;
  nextAttemptAt: number;
  error?: { status: number; title: string; detail?: string };
};

export interface QueueStore {
  all(): Promise<Job[]>;
  put(job: Job): Promise<void>;
  remove(id: string): Promise<void>;
}

export type SendResult = { status: number; body: unknown };

/** Thrown by a sender when the request can never be built (e.g. a queued photo is gone from the device). */
export class LocalDataError extends Error {
  name = "LocalDataError";
}
/** Performs one HTTP step. Throws only for transport failures (offline, DNS, timeout). */
export type Sender = (step: { method: Step["method"]; path: string; body?: StepBody; idempotencyKey: string }) => Promise<SendResult>;

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 5 * 60_000;

export function backoff(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.max(0, attempts - 1));
}

function lookup(results: unknown[], ref: string): unknown {
  const [index, ...fields] = ref.split(".");
  let value: unknown = results[Number(index)];
  for (const field of fields) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[field];
  }
  return value;
}

/** Replaces {n.field} in paths and {"$ref": "n.field"} in JSON bodies with earlier step results. */
export function resolveStep(step: Step, results: unknown[]): { path: string; body?: StepBody } {
  const path = step.path.replace(/\{(\d+(?:\.[A-Za-z0-9_]+)+)\}/g, (_, ref: string) => {
    const value = lookup(results, ref);
    if (value === undefined || value === null) throw new Error(`Unresolved reference ${ref}`);
    return encodeURIComponent(String(value));
  });
  if (!step.body || step.body.kind !== "json") return { path, body: step.body };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (typeof record.$ref === "string" && Object.keys(record).length === 1) return lookup(results, record.$ref);
      return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return { path, body: { kind: "json", value: walk(step.body.value) } };
}

function problemOf(status: number, body: unknown): Job["error"] {
  const b = (body ?? {}) as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title : `Request failed (${status})`;
  let detail = typeof b.detail === "string" ? b.detail : undefined;
  if (!detail && b.errors && typeof b.errors === "object") {
    detail = Object.entries(b.errors as Record<string, unknown>)
      .map(([field, messages]) => `${field}: ${Array.isArray(messages) ? messages.join(" ") : String(messages)}`)
      .join("; ");
  }
  return { status, title, detail };
}

export type RunOutcome = "done" | "failed" | "deferred";

/** Runs one job's remaining steps. Persists progress after every step. */
export async function runJob(job: Job, store: QueueStore, send: Sender, now: () => number = Date.now): Promise<RunOutcome> {
  job.status = "running";
  job.attempts += 1;
  await store.put(job);
  for (let i = job.results.length; i < job.steps.length; i++) {
    const step = job.steps[i];
    let resolved;
    try {
      resolved = resolveStep(step, job.results);
    } catch (e) {
      job.status = "failed";
      job.error = { status: 0, title: "This action can't continue.", detail: (e as Error).message };
      await store.put(job);
      return "failed";
    }
    let result: SendResult;
    try {
      result = await send({ method: step.method, path: resolved.path, body: resolved.body, idempotencyKey: step.idempotencyKey });
    } catch (e) {
      if (e instanceof LocalDataError || (e as Error | null)?.name === "LocalDataError") {
        job.status = "failed";
        job.error = { status: 0, title: (e as Error).message };
        await store.put(job);
        return "failed";
      }
      return defer(job, store, now, { status: 0, title: "Waiting for a connection." });
    }
    if (result.status >= 200 && result.status < 300) {
      job.results.push(result.body);
      job.error = undefined;
      await store.put(job);
      continue;
    }
    if (result.status === 401) {
      // Signed out or session expired: keep the job for when the user signs in again.
      return defer(job, store, now, { status: 401, title: "Sign in again to send this." });
    }
    if (RETRYABLE.has(result.status) || (result.status === 409 && isInProgress(result.body))) {
      return defer(job, store, now, problemOf(result.status, result.body));
    }
    job.status = "failed";
    job.error = problemOf(result.status, result.body);
    await store.put(job);
    return "failed";
  }
  job.status = "done";
  job.error = undefined;
  await store.put(job);
  return "done";
}

function isInProgress(body: unknown): boolean {
  // The same key is still being processed by an earlier send: wait and replay.
  return (body as { type?: string } | null)?.type === "idempotency_in_progress";
}

async function defer(job: Job, store: QueueStore, now: () => number, error: Job["error"]): Promise<RunOutcome> {
  job.status = "pending";
  job.error = error;
  job.nextAttemptAt = now() + backoff(job.attempts);
  await store.put(job);
  return "deferred";
}

/**
 * Sends waiting jobs strictly oldest first. A job that is waiting to retry holds back everything
 * queued after it, so actions reach the server in the order they were taken on the device (a count
 * entry before the count is submitted, a receipt before its correction). A failed job does not hold
 * the line: it needs a person, and later independent work should still go through.
 */
export async function drain(store: QueueStore, send: Sender, now: () => number = Date.now): Promise<Record<RunOutcome, number>> {
  const counts: Record<RunOutcome, number> = { done: 0, failed: 0, deferred: 0 };
  const jobs = (await store.all())
    .filter((j) => j.status === "pending" || j.status === "running")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const job of jobs) {
    if (job.nextAttemptAt > now()) break;
    const outcome = await runJob(job, store, send, now);
    counts[outcome] += 1;
    if (outcome === "deferred") break;
  }
  return counts;
}

/**
 * Puts a failed job back in line after the user fixed the cause (e.g. the PO was re-approved).
 * The refused step gets a new Idempotency-Key: the server stored its refusal under the old key and
 * would replay it, and a refused request changed nothing, so a fresh attempt can't double-apply.
 * Steps that already succeeded keep their keys and results.
 */
export async function retry(store: QueueStore, id: string, ids: () => string): Promise<void> {
  const job = (await store.all()).find((j) => j.id === id);
  if (!job || job.status !== "failed") return;
  const refused = job.steps[job.results.length];
  if (refused) refused.idempotencyKey = `m-${ids()}`;
  job.status = "pending";
  job.nextAttemptAt = 0;
  job.error = undefined;
  await store.put(job);
}

/** Drops sent jobs after they have been visible as a record for a while. */
export async function prune(store: QueueStore, olderThanMs: number, now: () => number = Date.now): Promise<void> {
  for (const job of await store.all()) {
    if (job.status === "done" && now() - Date.parse(job.createdAt) > olderThanMs) await store.remove(job.id);
  }
}

export function newJob(
  kind: string,
  label: string,
  steps: Omit<Step, "idempotencyKey">[],
  ids: () => string,
  now: () => number = Date.now,
): Job {
  return {
    id: ids(),
    kind,
    label,
    createdAt: new Date(now()).toISOString(),
    status: "pending",
    steps: steps.map((s) => ({ ...s, idempotencyKey: `m-${ids()}` })),
    results: [],
    attempts: 0,
    nextAttemptAt: 0,
  };
}

export class MemoryStore implements QueueStore {
  private jobs = new Map<string, Job>();
  async all() {
    return [...this.jobs.values()].map((j) => structuredClone(j));
  }
  async put(job: Job) {
    this.jobs.set(job.id, structuredClone(job));
  }
  async remove(id: string) {
    this.jobs.delete(id);
  }
}
