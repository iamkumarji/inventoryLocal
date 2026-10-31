"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

/**
 * A secret the server returns exactly once (signing secret, temporary password). Shown in full with a copy
 * button and an instruction; nothing here stores it.
 */
export function OneTimeSecret({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false),
    );
  };
  return (
    <div className="grid gap-2 rounded-md border border-status-pending/40 bg-status-pending/10 p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="size-4 text-status-pending" aria-hidden />
        {label}
      </p>
      <div className="flex min-w-0 items-stretch gap-2">
        <code className="num min-w-0 flex-1 rounded-sm border bg-card px-2.5 py-2 text-sm break-all select-all">{value}</code>
        <Button type="button" variant="outline" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`} className="h-auto shrink-0">
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      <span className="sr-only" aria-live="polite">{copied ? "Copied to clipboard" : ""}</span>
      {children && <div className="text-sm text-foreground/80">{children}</div>}
    </div>
  );
}
