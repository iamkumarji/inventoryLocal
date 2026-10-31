"use client";

import { UserX } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { useMyEmployee, type Employee } from "@/lib/api/people";

/**
 * Self-service frame: a narrow, phone-first column. Needs an employee record linked to the
 * signed-in account; otherwise explains what to ask HR for.
 */
export function SelfService({ title, description, actions, back, children }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  children: (employee: Employee) => ReactNode;
}) {
  const mine = useMyEmployee();
  return (
    <div className="mx-auto w-full max-w-2xl">
      <header className="mb-5">
        {back && <Link href={back.href} className="mb-2 inline-block text-sm text-muted-foreground underline-offset-4 hover:underline">← {back.label}</Link>}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="type-signage text-[1.75rem] text-foreground">{title}</h1>
            {description && <p className="mt-1 text-muted-foreground">{description}</p>}
          </div>
          {mine.data && actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      </header>
      {mine.isLoading ? <PageSkeleton /> : mine.error ? <ErrorState error={mine.error} onRetry={mine.refetch} /> : mine.data === null ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border bg-card px-5 py-8">
          <UserX className="size-5 text-muted-foreground" aria-hidden />
          <p className="font-medium">Your account isn&apos;t linked to an employee record</p>
          <p className="text-sm text-muted-foreground">Ask HR to link your sign-in to your employee record, then come back here.</p>
        </div>
      ) : children(mine.data!)}
    </div>
  );
}

/** A tappable card row used in self-service lists. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border bg-card ${className}`}>{children}</div>;
}
