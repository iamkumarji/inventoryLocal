import type { ReactNode } from "react";

import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type LedgerColumn = { key: string; header: ReactNode; align?: "left" | "right"; className?: string };

/**
 * A financial table: amount columns right-aligned with tabular digits, a totals footer, and horizontal
 * scrolling inside its own container so the page never scrolls sideways on a phone.
 */
export function LedgerTable({ columns, children, footer, caption, className }: {
  columns: LedgerColumn[];
  children: ReactNode;
  footer?: ReactNode;
  caption?: string;
  className?: string;
}) {
  return (
    <Table className={cn("num", className)}>
      {caption && <caption className="sr-only">{caption}</caption>}
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {columns.map((c) => (
            <TableHead key={c.key} scope="col"
              className={cn("h-9 px-3 text-xs font-medium whitespace-nowrap text-muted-foreground", c.align === "right" && "text-right", c.className)}>
              {c.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
      {footer && <TableFooter>{footer}</TableFooter>}
    </Table>
  );
}

export function Cell({ children, align, className, colSpan, heading }: {
  children?: ReactNode;
  align?: "left" | "right";
  className?: string;
  colSpan?: number;
  heading?: boolean;
}) {
  return (
    <TableCell colSpan={colSpan} scope={heading ? "row" : undefined}
      className={cn("h-9 px-3 py-2", align === "right" && "text-right", className)}>
      {children}
    </TableCell>
  );
}

export { TableRow as Row };
