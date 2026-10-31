"use client";

import type { ReactNode } from "react";

import { FormError } from "@/components/erp/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { problemMessage } from "@/lib/api/production";
import { cn } from "@/lib/utils";

/** A dialog holding one form for one API action; the API's problem message appears next to the submit button. */
export function ActionDialog({
  trigger,
  title,
  description,
  submitLabel,
  pending,
  error,
  disabled,
  onSubmit,
  open,
  onOpenChange,
  children,
  wide,
  destructive,
}: {
  trigger?: ReactNode;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  pending?: boolean;
  error?: unknown;
  disabled?: boolean;
  onSubmit: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
  wide?: boolean;
  destructive?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className={cn("max-h-[92dvh] overflow-y-auto", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}>
        <form
          className="grid min-w-0 gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!disabled && !pending) onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          <FormError message={problemMessage(error)} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" size="lg" variant={destructive ? "destructive" : "default"} disabled={pending || disabled}>
              {pending ? "Working…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Label/value pairs in a compact grid. */
export function Facts({ items, className }: { items: Array<[ReactNode, ReactNode] | false | "" | 0 | null | undefined>; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 px-5 py-4 text-sm", className)}>
      {items.filter(Boolean).map((entry, index) => {
        const [label, value] = entry as [ReactNode, ReactNode];
        return (
          <span key={index} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </span>
        );
      })}
    </dl>
  );
}

/** Large figure tiles (costing, reliability). */
export function Figure({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className="min-w-0 rounded-md border bg-background/50 px-4 py-3">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className={cn("num mt-1 truncate text-lg font-semibold", tone === "good" && "text-status-approved", tone === "bad" && "text-status-rejected")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
