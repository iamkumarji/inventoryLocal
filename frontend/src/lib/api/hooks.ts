"use client";

import { useQuery } from "@tanstack/react-query";

import { api, unwrap } from "./client";

export function useInbox() {
  return useQuery({ queryKey: ["approvals", "inbox"], queryFn: () => unwrap(api.GET("/api/v1/approvals/inbox/")) });
}

export function useScopeTree() {
  return useQuery({
    queryKey: ["organization", "scope-tree"],
    queryFn: () => unwrap(api.GET("/api/v1/organization/scope-tree/")),
    staleTime: 5 * 60_000,
  });
}

export function useRoles() {
  return useQuery({
    queryKey: ["authorization", "roles", "all"],
    queryFn: () => unwrap(api.GET("/api/v1/authorization/roles/", { params: { query: { page_size: 200 } } })),
  });
}

export function usePermissionCatalog() {
  return useQuery({
    queryKey: ["authorization", "permissions"],
    queryFn: () => unwrap(api.GET("/api/v1/authorization/permissions/")),
    staleTime: 10 * 60_000,
  });
}
