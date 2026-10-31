import Link from "next/link";
import type { ReactNode } from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export type Crumb = { label: string; href?: string };

export function PageHeader({
  title,
  description,
  crumbs = [],
  actions,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {crumbs.length > 0 && (
          <Breadcrumb className="mb-2">
            <BreadcrumbList>
              {crumbs.map((crumb, index) => (
                <span key={`${crumb.label}-${index}`} className="contents">
                  <BreadcrumbItem>
                    {crumb.href ? (
                      <BreadcrumbLink asChild>
                        <Link href={crumb.href}>{crumb.label}</Link>
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                  {index < crumbs.length - 1 && <BreadcrumbSeparator />}
                </span>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        )}
        <h1 className="type-signage text-[1.75rem] text-foreground">{title}</h1>
        {description && <p className="mt-1.5 max-w-[68ch] text-muted-foreground">{description}</p>}
        {meta && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, description, actions, children, className = "" }: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border bg-card ${className}`}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b px-5 py-3.5">
          <div>
            {title && <h2 className="type-section">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
