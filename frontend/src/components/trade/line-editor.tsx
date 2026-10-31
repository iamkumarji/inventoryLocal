"use client";

import { Plus, Trash2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type LineColumn<L> = {
  key: string;
  label: string;
  /** Grid track on wide screens, e.g. "minmax(12rem,2fr)" or "6rem". */
  width: string;
  /** Spans both columns on phones. */
  wide?: boolean;
  render: (line: L, update: (patch: Partial<L>) => void, id: string, index: number) => ReactNode;
};

/**
 * Document lines editor: a grid row per line on wide screens, a labelled card per line on phones.
 * Every input is labelled "Line N <column>" for assistive technology and tests.
 */
export function LineEditor<L>({ idPrefix, lines, onChange, columns, blank, addLabel = "Add line", minLines = 1, footer, readOnlyCount = false }: {
  idPrefix: string;
  lines: L[];
  onChange: (lines: L[]) => void;
  columns: LineColumn<L>[];
  blank?: () => L;
  addLabel?: string;
  minLines?: number;
  footer?: ReactNode;
  /** Lines come from a source document: no add/remove. */
  readOnlyCount?: boolean;
}) {
  const template = [...columns.map((c) => c.width), readOnlyCount ? "" : "2.25rem"].filter(Boolean).join(" ");
  const style = { "--cols": template } as CSSProperties;
  const update = (index: number, patch: Partial<L>) => onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  return (
    <div className="grid gap-2">
      <div style={style} className="hidden gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[var(--cols)]" aria-hidden>
        {columns.map((c) => <span key={c.key}>{c.label}</span>)}
        {!readOnlyCount && <span />}
      </div>
      <ol className="grid gap-2">
        {lines.map((line, index) => (
          <li key={index} style={style}
            className="grid grid-cols-2 items-start gap-2 rounded-md border bg-background p-2.5 sm:grid-cols-[var(--cols)] sm:border-0 sm:bg-transparent sm:p-0 sm:px-1">
            {columns.map((c) => {
              const id = `${idPrefix}-${index}-${c.key}`;
              return (
                <div key={c.key} className={cn("grid min-w-0 gap-1", c.wide && "col-span-2 sm:col-span-1")}>
                  <Label htmlFor={id} className="text-xs text-muted-foreground sm:sr-only">
                    <span className="sr-only">Line {index + 1} </span>{c.label}
                  </Label>
                  {c.render(line, (patch) => update(index, patch), id, index)}
                </div>
              );
            })}
            {!readOnlyCount && (
              <div className="col-span-2 flex justify-end sm:col-span-1">
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${index + 1}`}
                  disabled={lines.length <= minLines} onClick={() => onChange(lines.filter((_, i) => i !== index))}>
                  <Trash2 />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {!readOnlyCount && blank ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onChange([...lines, blank()])}>
            <Plus aria-hidden /> {addLabel}
          </Button>
        ) : <span />}
        {footer}
      </div>
    </div>
  );
}
