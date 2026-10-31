"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Field } from "@/components/erp/field";
import { Section } from "@/components/erp/page-header";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { isApiError } from "@/lib/api/errors";

import { ActionError, type DenialHints } from "./common";

export function StatusFilter({ value, options, onChange, label = "Filter by status" }: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <Button key={v || "any"} size="sm" variant={value === v ? "secondary" : "ghost"} aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </Button>
      ))}
    </div>
  );
}

export function FormSheet({ open, onOpenChange, title, description, children, wide = true }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className={`w-full overflow-y-auto ${wide ? "sm:max-w-4xl" : "sm:max-w-xl"}`}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="px-4 pb-8">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Runs a document action and refreshes every trade query afterwards (also after a version conflict,
 * so the screen shows the latest state).
 */
export function useTradeAction<V, T>(fn: (vars: V) => Promise<T>, onDone?: (data: T, vars: V) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["trade"] });
      onDone?.(data, vars);
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict") || isApiError(error, "invalid_state_transition")) {
        queryClient.invalidateQueries({ queryKey: ["trade"] });
      }
    },
  });
}

/** Approve / reject with a comment. The comment is required to reject (or always, when noteRequired). */
export function DecisionPanel({ title = "Your decision", description, onDecide, pending, error, hints, approveLabel = "Approve",
  rejectLabel = "Reject", noteLabel = "Comment", noteRequired = false }: {
  title?: string;
  description?: ReactNode;
  onDecide: (approve: boolean, note: string) => void;
  pending: boolean;
  error: unknown;
  hints?: DenialHints;
  approveLabel?: string;
  rejectLabel?: string;
  noteLabel?: string;
  noteRequired?: boolean;
}) {
  const [note, setNote] = useState("");
  return (
    <Section title={title} description={description}>
      <form className="grid gap-3 px-5 py-4" onSubmit={(e) => e.preventDefault()}>
        <ActionError error={error} hints={hints} />
        <Field id="decision-note" label={noteLabel} hint={noteRequired ? "Required. Recorded in the audit trail." : "Required when you reject. Recorded in the audit trail."}>
          <Textarea id="decision-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={pending || (noteRequired && !note.trim())} onClick={() => onDecide(true, note)}>
            <Check aria-hidden /> {approveLabel}
          </Button>
          <Button type="button" variant="outline" className="border-status-rejected/40 text-status-rejected hover:bg-status-rejected/10"
            disabled={pending || !note.trim()} onClick={() => onDecide(false, note)}>
            <X aria-hidden /> {rejectLabel}
          </Button>
        </div>
      </form>
    </Section>
  );
}

/** Sticky-free action strip for document headers. */
export function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
