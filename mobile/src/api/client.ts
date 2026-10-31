import createClient, { type Middleware } from "openapi-fetch";

import { apiBaseUrl } from "@/lib/config";
import { tokenStore } from "@/lib/token-store";

import type { paths } from "./schema";

export type Problem = { type?: string; title?: string; detail?: string; code?: string; errors?: Record<string, string[]> };

export class ApiError extends Error {
  constructor(
    public status: number,
    public problem: Problem,
  ) {
    super(problem.title ?? `Request failed (${status})`);
  }
}

type Listener = () => void;
const signedOut = new Set<Listener>();
export function onSignedOut(fn: Listener) {
  signedOut.add(fn);
  return () => {
    signedOut.delete(fn);
  };
}

export async function authHeaders(): Promise<Record<string, string>> {
  const [token, company] = await Promise.all([tokenStore.get(), tokenStore.getCompany()]);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (company) headers["X-Company-ID"] = company;
  return headers;
}

const auth: Middleware = {
  async onRequest({ request }) {
    for (const [k, v] of Object.entries(await authHeaders())) request.headers.set(k, v);
    return request;
  },
  async onResponse({ response, request }) {
    if (response.status === 401 && !new URL(request.url, "http://x").pathname.startsWith("/api/v1/auth/login")) {
      signedOut.forEach((fn) => fn());
    }
    return response;
  },
};

export const api = createClient<paths>({ baseUrl: apiBaseUrl() });
api.use(auth);

export async function unwrap<T>(promise: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await promise;
  if (error !== undefined || !response.ok) throw new ApiError(response.status, (error ?? {}) as Problem);
  return data as T;
}

/** Human message for an API or network error. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    const { title, detail, errors } = error.problem;
    const fields = errors ? Object.entries(errors).map(([f, m]) => `${f}: ${m.join(" ")}`).join("; ") : "";
    return [title, detail, fields].filter(Boolean).join(" — ") || `Request failed (${error.status})`;
  }
  if (error instanceof TypeError) return "No connection to the server.";
  return error instanceof Error ? error.message : String(error);
}
