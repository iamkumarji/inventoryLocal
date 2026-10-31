"use client";

const KEY = "erp.activeCompany";
const listeners = new Set<() => void>();

export function getActiveCompany(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setActiveCompany(id: string | null) {
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the server default company applies */
  }
  listeners.forEach((fn) => fn());
}

export function subscribeCompany(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
