import { authHeaders } from "@/api/client";
import { apiBaseUrl } from "@/lib/config";

import type { Sender } from "./core";
import { filePart } from "./file-part";

/** Sends one queued step with the step's own Idempotency-Key. */
export const httpSender: Sender = async ({ method, path, body, idempotencyKey }) => {
  const headers: Record<string, string> = { ...(await authHeaders()), "Idempotency-Key": idempotencyKey, Accept: "application/json" };
  let payload: BodyInit | undefined;
  if (body?.kind === "json") {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.value);
  } else if (body?.kind === "file") {
    const form = new FormData();
    for (const [k, v] of Object.entries(body.fields)) form.append(k, v);
    await filePart(form, body.file);
    payload = form;
  }
  const response = await fetch(`${apiBaseUrl()}${path}`, { method, headers, body: payload });
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
};
