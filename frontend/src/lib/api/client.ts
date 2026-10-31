"use client";

import createClient, { type Middleware } from "openapi-fetch";

import { getActiveCompany } from "@/lib/company";

import { ApiError, type Problem } from "./errors";
import type { paths } from "./schema";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

type AuthEvent = "unauthenticated" | "mfa_enrollment_required" | "password_change_required";
const authListeners = new Set<(event: AuthEvent) => void>();

export function onAuthEvent(fn: (event: AuthEvent) => void) {
  authListeners.add(fn);
  return () => {
    authListeners.delete(fn);
  };
}

const middleware: Middleware = {
  onRequest({ request }) {
    if (UNSAFE.has(request.method)) {
      const csrf = readCookie("erp_csrf");
      if (csrf) request.headers.set("X-CSRF-Token", csrf);
    }
    const company = getActiveCompany();
    if (company) request.headers.set("X-Company-ID", company);
    return request;
  },
  async onResponse({ response, request }) {
    if (response.ok) return response;
    let problem: Partial<Problem> | undefined;
    try {
      problem = await response.clone().json();
    } catch {
      problem = undefined;
    }
    const path = new URL(request.url).pathname;
    // A wrong password or code typed into a form (sign-in, step-up, turning MFA off) answers that form;
    // it doesn't mean the session expired.
    const isCodeCheck = ["/api/v1/auth/login", "/api/v1/auth/step-up", "/api/v1/auth/mfa/disable"].some((p) =>
      path.startsWith(p),
    );
    if (response.status === 401 && !isCodeCheck) authListeners.forEach((fn) => fn("unauthenticated"));
    if (problem?.type === "mfa_enrollment_required" || problem?.type === "password_change_required") {
      authListeners.forEach((fn) => fn(problem!.type as AuthEvent));
    }
    return response;
  },
};

export const api = createClient<paths>({ baseUrl: "", credentials: "same-origin" });
api.use(middleware);

/** Unwraps an openapi-fetch result, throwing ApiError on failure. */
export async function unwrap<T>(
  promise: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await promise;
  if (!response.ok) throw new ApiError(response.status, error as Partial<Problem>);
  return data as T;
}

export function idempotencyKey(): string {
  return crypto.randomUUID();
}
