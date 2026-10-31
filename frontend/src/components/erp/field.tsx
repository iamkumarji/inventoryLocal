import type { ReactNode } from "react";

import { Label } from "@/components/ui/label";

export function Field({ id, label, hint, error, children, className = "" }: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`grid gap-1.5 ${className}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-status-rejected/30 bg-status-rejected/10 px-3 py-2 text-sm text-status-rejected">
      {message}
    </p>
  );
}
