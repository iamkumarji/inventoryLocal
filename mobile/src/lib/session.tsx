import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { api, ApiError, onSignedOut, unwrap } from "@/api/client";

import { newId } from "./ids";
import { tokenStore } from "./token-store";

export type Me = {
  user: { id: string; email: string; full_name: string };
  active_company_id: string | null;
  companies: { id: string; code: string; name: string }[];
  permissions: { codes: string[]; conditional: string[] };
  feature_flags: Record<string, boolean>;
  session: { restricted_reason: "mfa_enrollment" | "password_change" | null };
};

type State = { status: "loading" } | { status: "signed_out"; notice?: string } | { status: "signed_in"; me: Me };

type LoginOutcome = { kind: "done" } | { kind: "mfa"; challenge: string } | { kind: "error"; message: string };

type SessionValue = {
  state: State;
  me: Me | null;
  can: (code: string) => boolean;
  canAny: (codes: readonly string[]) => boolean;
  flag: (key: string) => boolean;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  completeMfa: (challenge: string, code: string) => Promise<LoginOutcome>;
  logout: () => Promise<void>;
  switchCompany: (id: string) => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}

async function deviceId(): Promise<string> {
  const existing = await tokenStore.getDevice();
  if (existing) return existing;
  const id = newId();
  await tokenStore.setDevice(id);
  return id;
}

type LoginBody = { status: string; token?: string; challenge_token?: string };

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });

  const loadMe = useCallback(async (notice?: string) => {
    try {
      const me = (await unwrap(api.GET("/api/v1/auth/me/"))) as unknown as Me;
      if (me.session.restricted_reason) {
        await tokenStore.clear();
        setState({
          status: "signed_out",
          notice:
            me.session.restricted_reason === "mfa_enrollment"
              ? "Set up two-step sign-in in the web app first, then sign in here."
              : "Change your temporary password in the web app first, then sign in here.",
        });
        return;
      }
      if (!(await tokenStore.getCompany()) && me.active_company_id) await tokenStore.setCompany(me.active_company_id);
      setState({ status: "signed_in", me });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await tokenStore.clear();
        setState({ status: "signed_out", notice });
      } else {
        // Offline at start-up with a stored session: let the user keep working on queued tasks.
        const token = await tokenStore.get();
        setState(token ? { status: "signed_out", notice: "Can't reach the server. Check the connection and try again." } : { status: "signed_out" });
      }
    }
  }, []);

  useEffect(() => {
    void (async () => ((await tokenStore.get()) ? loadMe() : setState({ status: "signed_out" })))();
    return onSignedOut(() => {
      void tokenStore.clear();
      setState({ status: "signed_out", notice: "Your session ended. Sign in again; queued work is kept." });
    });
  }, [loadMe]);

  const finish = useCallback(
    async (body: LoginBody): Promise<LoginOutcome> => {
      if (body.status === "mfa_required" && body.challenge_token) return { kind: "mfa", challenge: body.challenge_token };
      if (!body.token) return { kind: "error", message: "Sign-in did not return a session." };
      await tokenStore.set(body.token);
      await loadMe();
      return { kind: "done" };
    },
    [loadMe],
  );

  const value = useMemo<SessionValue>(() => {
    const me = state.status === "signed_in" ? state.me : null;
    const codes = new Set(me?.permissions.codes ?? []);
    const conditional = new Set(me?.permissions.conditional ?? []);
    const can = (code: string) => codes.has(code) || conditional.has(code);
    return {
      state,
      me,
      can,
      canAny: (list) => list.length === 0 || list.some(can),
      flag: (key) => Boolean(me?.feature_flags[key]),
      login: async (email, password) => {
        try {
          const body = (await unwrap(
            api.POST("/api/v1/auth/login/", { body: { email, password, client_type: "mobile", device_id: await deviceId() } }),
          )) as LoginBody;
          return finish(body);
        } catch (e) {
          return { kind: "error", message: e instanceof ApiError ? (e.problem.title ?? "Sign-in failed.") : "No connection to the server." };
        }
      },
      completeMfa: async (challenge, code) => {
        try {
          const body = (await unwrap(api.POST("/api/v1/auth/login/mfa/", { body: { challenge_token: challenge, code } }))) as LoginBody;
          return finish(body);
        } catch (e) {
          return { kind: "error", message: e instanceof ApiError ? (e.problem.title ?? "Code not accepted.") : "No connection to the server." };
        }
      },
      logout: async () => {
        try {
          await api.POST("/api/v1/auth/logout/");
        } finally {
          await tokenStore.clear();
          setState({ status: "signed_out" });
        }
      },
      switchCompany: async (id) => {
        await tokenStore.setCompany(id);
        await loadMe();
      },
    };
  }, [finish, loadMe, state]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
