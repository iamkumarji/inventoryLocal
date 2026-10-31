"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { ErrorState, RowsSkeleton } from "./states";

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: "left" | "right";
};

export function DataTable<T extends { id?: string }>({
  columns,
  rows,
  isLoading,
  error,
  onRetry,
  empty,
  rowHref,
  caption,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: ReactNode;
  rowHref?: (row: T) => string;
  caption?: string;
}) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (isLoading || !rows) return <RowsSkeleton />;
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div className="overflow-x-auto">
      <Table>
        {caption && <caption className="sr-only">{caption}</caption>}
        <TableHeader className="sticky top-0 bg-card">
          <TableRow className="hover:bg-transparent">
            {columns.map((col) => (
              <TableHead
                key={col.key}
                className={cn("h-9 text-xs font-medium text-muted-foreground", col.align === "right" && "text-right", col.className)}
              >
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={row.id ?? index} className={cn(rowHref && "relative cursor-pointer")}>
              {columns.map((col, colIndex) => (
                <TableCell
                  key={col.key}
                  className={cn("h-10 py-2", col.align === "right" && "text-right", col.className)}
                >
                  {colIndex === 0 && rowHref ? (
                    <Link href={rowHref(row)} className="font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-ring">
                      {col.cell(row)}
                    </Link>
                  ) : (
                    col.cell(row)
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function PageNav({ page, count, pageSize, onPage }: {
  page: number;
  count: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(count / pageSize));
  if (count <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, count);
  return (
    <div className="flex items-center justify-between border-t px-5 py-2.5 text-sm text-muted-foreground">
      <span className="num">
        {from}–{to} of {count}
      </span>
      <div className="flex gap-1">
        <Button variant="ghost" size="icon-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
