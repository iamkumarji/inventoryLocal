import { AlertTriangle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isApiError } from "@/lib/api/errors";

export function EmptyState({ icon: Icon, title, description, action }: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-5 py-10">
      {Icon && <Icon className="size-5 text-muted-foreground" aria-hidden />}
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-[60ch] text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const forbidden = isApiError(error) && (error.status === 403 || error.status === 404);
  const message = forbidden
    ? "You don't have access to this, or it doesn't exist. Ask an administrator if you need it."
    : isApiError(error)
      ? error.summary()
      : "The server couldn't be reached. Check your connection.";
  return (
    <div role="alert" className="flex items-start gap-3 px-5 py-8">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-status-rejected" aria-hidden />
      <div>
        <p className="font-medium">{forbidden ? "Not available" : "Couldn't load this"}</p>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
        {onRetry && !forbidden && (
          <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

export function RowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 p-5" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-7 w-full" />
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton className="mb-3 h-4 w-40" />
      <Skeleton className="mb-8 h-8 w-72" />
      <Skeleton className="h-72 w-full rounded-lg" />
    </div>
  );
}
