import { backoff, drain, LocalDataError, MemoryStore, newJob, prune, resolveStep, retry, runJob, type Sender } from "../core";

let seq = 0;
const ids = () => `id${++seq}`;

/** A fake server that stores responses by idempotency key, like the ERP API does. */
function fakeServer() {
  const stored = new Map<string, { status: number; body: unknown }>();
  const calls: { path: string; key: string; replay: boolean }[] = [];
  let receipts = 0;
  let online = true;
  let loseNextResponse = false;
  let reject: { status: number; body: unknown } | null = null;
  const send: Sender = async ({ path, idempotencyKey }) => {
    if (!online) throw new TypeError("Network request failed");
    const prior = stored.get(idempotencyKey);
    if (prior) {
      calls.push({ path, key: idempotencyKey, replay: true });
      return prior;
    }
    calls.push({ path, key: idempotencyKey, replay: false });
    let response: { status: number; body: unknown };
    if (reject) {
      response = reject;
    } else if (path === "/api/v1/procurement/receipts/") {
      receipts += 1;
      response = { status: 201, body: { id: `grn-${receipts}`, version: 1 } };
    } else {
      response = { status: 200, body: { ok: true, path } };
    }
    if (response.status < 500) stored.set(idempotencyKey, response);
    if (loseNextResponse) {
      loseNextResponse = false;
      throw new TypeError("Connection reset"); // the server acted, the phone never heard back
    }
    return response;
  };
  return {
    send,
    calls,
    get receipts() {
      return receipts;
    },
    setOnline: (v: boolean) => (online = v),
    loseNext: () => (loseNextResponse = true),
    rejectWith: (r: typeof reject) => (reject = r),
  };
}

const receiveJob = () =>
  newJob(
    "goods_receipt",
    "Receive PO-1",
    [
      { method: "POST", path: "/api/v1/procurement/receipts/", body: { kind: "json", value: { purchase_order: "po1" } } },
      { method: "POST", path: "/api/v1/procurement/receipts/{0.id}/post/", body: { kind: "json", value: { version: { $ref: "0.version" } } } },
    ],
    ids,
    () => 1000,
  );

test("multi-step job resolves later steps from earlier responses", async () => {
  const store = new MemoryStore();
  const server = fakeServer();
  const job = receiveJob();
  await store.put(job);
  expect(await runJob(job, store, server.send)).toBe("done");
  expect(server.calls.map((c) => c.path)).toEqual(["/api/v1/procurement/receipts/", "/api/v1/procurement/receipts/grn-1/post/"]);
  const [saved] = await store.all();
  expect(saved.status).toBe("done");
});

test("a lost response is replayed with the same key and the server acts once", async () => {
  const store = new MemoryStore();
  const server = fakeServer();
  const job = receiveJob();
  await store.put(job);
  server.loseNext();
  expect(await runJob(job, store, server.send, () => 0)).toBe("deferred");
  expect(server.receipts).toBe(1);
  const [pending] = await store.all();
  expect(pending.status).toBe("pending");
  expect(await runJob(pending, store, server.send)).toBe("done");
  expect(server.receipts).toBe(1); // replayed, not created twice
  expect(server.calls[1]).toMatchObject({ path: "/api/v1/procurement/receipts/", replay: true });
  expect(server.calls[2].path).toBe("/api/v1/procurement/receipts/grn-1/post/");
});

test("offline jobs wait with backoff and drain in order when back online", async () => {
  const store = new MemoryStore();
  const server = fakeServer();
  let clock = 0;
  const now = () => clock;
  const a = newJob("count", "Count A", [{ method: "POST", path: "/a/" }], ids, () => 1);
  const b = newJob("count", "Count B", [{ method: "POST", path: "/b/" }], ids, () => 2);
  await store.put(b);
  await store.put(a);
  server.setOnline(false);
  expect(await drain(store, server.send, now)).toEqual({ done: 0, failed: 0, deferred: 1 }); // stops after first
  clock += backoff(1) - 1;
  expect(await drain(store, server.send, now)).toEqual({ done: 0, failed: 0, deferred: 0 }); // not due yet
  server.setOnline(true);
  clock += 1;
  expect(await drain(store, server.send, now)).toEqual({ done: 2, failed: 0, deferred: 0 });
  expect(server.calls.map((c) => c.path)).toEqual(["/a/", "/b/"]);
});

test("business rejections fail the job with the server's message and are not retried", async () => {
  const store = new MemoryStore();
  const server = fakeServer();
  server.rejectWith({
    status: 422,
    body: { type: "business_rule_violation", title: "Receipt exceeds the order by more than 5%.", code: "over_receipt" },
  });
  const job = receiveJob();
  await store.put(job);
  expect(await runJob(job, store, server.send)).toBe("failed");
  const [failed] = await store.all();
  expect(failed.error).toEqual({ status: 422, title: "Receipt exceeds the order by more than 5%.", detail: undefined });
  expect(await drain(store, server.send)).toEqual({ done: 0, failed: 0, deferred: 0 });
  // Resending the same key replays the stored refusal: nothing changes behind the user's back.
  const replay = await server.send({ method: "POST", path: "/api/v1/procurement/receipts/", idempotencyKey: failed.steps[0].idempotencyKey });
  expect(replay.status).toBe(422);
  // After the cause is fixed, "Try again" sends the refused step under a new key.
  server.rejectWith(null);
  await retry(store, failed.id, ids);
  expect(await drain(store, server.send)).toEqual({ done: 1, failed: 0, deferred: 0 });
  expect(server.receipts).toBe(1);
});

test("retry keeps keys of steps that already succeeded", async () => {
  const store = new MemoryStore();
  const job = receiveJob();
  await store.put(job);
  const send: Sender = async ({ path }) =>
    path.endsWith("/post/") ? { status: 422, body: { title: "Period closed." } } : { status: 201, body: { id: "g1", version: 1 } };
  await runJob(job, store, send);
  const [failed] = await store.all();
  await retry(store, failed.id, ids);
  const [again] = await store.all();
  expect(again.steps[0].idempotencyKey).toBe(failed.steps[0].idempotencyKey);
  expect(again.steps[1].idempotencyKey).not.toBe(failed.steps[1].idempotencyKey);
  expect(again.results).toHaveLength(1);
});

test("sent jobs are pruned after the retention period", async () => {
  const store = new MemoryStore();
  const job = newJob("x", "x", [{ method: "POST", path: "/x/" }], ids, () => 0);
  job.status = "done";
  await store.put(job);
  await prune(store, 1000, () => 500);
  expect(await store.all()).toHaveLength(1);
  await prune(store, 1000, () => 1001);
  expect(await store.all()).toHaveLength(0);
});

test("validation errors are summarised per field", async () => {
  const store = new MemoryStore();
  const job = newJob("x", "x", [{ method: "POST", path: "/x/" }], ids);
  await store.put(job);
  const send: Sender = async () => ({ status: 400, body: { title: "Invalid input.", errors: { quantity: ["Must be positive."] } } });
  await runJob(job, store, send);
  expect((await store.all())[0].error?.detail).toBe("quantity: Must be positive.");
});

test("401 and 5xx keep the job pending", async () => {
  for (const status of [401, 503, 429]) {
    const store = new MemoryStore();
    const job = newJob("x", "x", [{ method: "POST", path: "/x/" }], ids);
    await store.put(job);
    expect(await runJob(job, store, async () => ({ status, body: {} }))).toBe("deferred");
    expect((await store.all())[0].status).toBe("pending");
  }
});

test("each step gets its own key, fixed when queued", () => {
  const job = receiveJob();
  const keys = job.steps.map((s) => s.idempotencyKey);
  expect(new Set(keys).size).toBe(2);
  expect(keys.every((k) => k.startsWith("m-"))).toBe(true);
});

test("unresolvable references fail clearly", () => {
  expect(() => resolveStep({ method: "POST", path: "/x/{0.id}/", idempotencyKey: "k" }, [])).toThrow("Unresolved reference 0.id");
  const resolved = resolveStep(
    { method: "POST", path: "/x/", idempotencyKey: "k", body: { kind: "json", value: { lines: [{ v: { $ref: "0.version" } }] } } },
    [{ version: 3 }],
  );
  expect(resolved.body).toEqual({ kind: "json", value: { lines: [{ v: 3 }] } });
});

test("a queued photo that is gone fails the job instead of waiting forever", async () => {
  const store = new MemoryStore();
  const job = newJob("x", "x", [{ method: "POST", path: "/api/v1/documents/documents/" }], ids);
  await store.put(job);
  const send: Sender = async () => {
    throw new LocalDataError("The photo is no longer on this phone.");
  };
  expect(await runJob(job, store, send)).toBe("failed");
  expect((await store.all())[0].error?.title).toBe("The photo is no longer on this phone.");
});

test("a detail identical to the title isn't repeated", async () => {
  const store = new MemoryStore();
  const job = newJob("x", "x", [{ method: "POST", path: "/x/" }], ids);
  await store.put(job);
  const same = "You do not have permission to perform this action.";
  await runJob(job, store, async () => ({ status: 403, body: { title: same, detail: same } }));
  expect((await store.all())[0].error).toEqual({ status: 403, title: same, detail: undefined });
});
