"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";

import { api, onAuthEvent, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { getActiveCompany, setActiveCompany } from "@/lib/company";

export type Grant = { scope_type: string; scope_id: string; role: string };

export type Me = {
  user: { id: string; email: string; full_name: string; phone: string; organization_id: string | null };
  active_company_id: string | null;
  companies: { id: string; code: string; name: string }[];
  roles: string[];
  permissions: { codes: string[]; grants: Record<string, Grant[]>; conditional: string[] };
  feature_flags: Record<string, boolean>;
  mfa: { enrolled: boolean; required: boolean; verified_at: string | null };
  session: {
    id: string;
    client_type: string;
    restricted_reason: "mfa_enrollment" | "password_change" | null;
    idle_expires_at: string;
    absolute_expires_at: string;
  };
};

export const ME_KEY = ["auth", "me"] as const;

export async function fetchMe(): Promise<Me> {
  return (await unwrap(api.GET("/api/v1/auth/me/"))) as unknown as Me;
}

type SessionValue = {
  me: Me;
  can: (code: string) => boolean;
  canAny: (codes: readonly string[]) => boolean;
  flag: (key: string) => boolean;
  switchCompany: (id: string) => void;
  activeCompany: Me["companies"][number] | undefined;
};

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionGate>");
  return value;
}

function restrictedPath(reason: Me["session"]["restricted_reason"]): string | null {
  if (reason === "mfa_enrollment") return "/setup/mfa";
  if (reason === "password_change") return "/setup/password";
  return null;
}

/** Loads /auth/me and routes unauthenticated or restricted sessions to the right screen. */
export function SessionGate({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ME_KEY, queryFn: fetchMe, retry: false, staleTime: 60_000 });

  useEffect(
    () =>
      onAuthEvent((event) => {
        if (event === "unauthenticated") {
          queryClient.clear();
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        } else {
          router.replace(event === "mfa_enrollment_required" ? "/setup/mfa" : "/setup/password");
        }
      }),
    [pathname, queryClient, router],
  );

  useEffect(() => {
    if (isApiError(query.error) && query.error.status === 401) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
    const target = query.data ? restrictedPath(query.data.session.restricted_reason) : null;
    if (target && pathname !== target) router.replace(target);
  }, [query.error, query.data, pathname, router]);

  const me = query.data;
  const switchCompany = useCallback(
    (id: string) => {
      setActiveCompany(id);
      queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const value = useMemo<SessionValue | null>(() => {
    if (!me) return null;
    const codes = new Set(me.permissions.codes);
    const activeId = getActiveCompany() ?? me.active_company_id;
    return {
      me,
      can: (code) => codes.has(code),
      canAny: (list) => list.length === 0 || list.some((c) => codes.has(c)),
      flag: (key) => me.feature_flags[key] === true,
      switchCompany,
      activeCompany: me.companies.find((c) => c.id === activeId) ?? me.companies[0],
    };
  }, [me, switchCompany]);

  if (!value || value.me.session.restricted_reason) return <>{fallback}</>;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
