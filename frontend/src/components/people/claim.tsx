"use client";

import { Paperclip } from "lucide-react";

import { trimDecimal, useCategories, type Claim, type ClaimLine } from "@/lib/api/people";
import { date } from "@/lib/format";

import { Amount } from "./amount";

/** Claim lines as stacked cards on phones and a table from `sm` up. */
export function ClaimLines({ claim }: { claim: Claim }) {
  const categories = useCategories();
  const name = (line: ClaimLine) => categories.data?.results.find((c) => c.id === line.category)?.name ?? line.category_code;
  const vehicle = (l: ClaimLine) => (l.vehicle_registration ? `${l.vehicle_registration} · ${trimDecimal(l.odometer)} km · ${trimDecimal(l.litres)} L` : "");
  return (
    <>
      <ul className="divide-y sm:hidden">
        {claim.lines.map((l) => (
          <li key={l.id} className="grid gap-0.5 px-5 py-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium">{l.description}</span>
              <Amount value={l.amount} currency={claim.currency} className="shrink-0 font-medium" />
            </div>
            <span className="text-muted-foreground">{name(l)} · {date(l.expense_date)}</span>
            {vehicle(l) && <span className="text-xs text-muted-foreground">{vehicle(l)}</span>}
            {l.receipt_reference && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Paperclip className="size-3" aria-hidden /> {l.receipt_reference}</span>}
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-5 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium">Receipt</th>
              <th className="px-5 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {claim.lines.map((l) => (
              <tr key={l.id}>
                <td className="num px-5 py-2 text-muted-foreground">{l.line_no}</td>
                <td className="num px-3 py-2 whitespace-nowrap">{date(l.expense_date)}</td>
                <td className="px-3 py-2">{name(l)}</td>
                <td className="px-3 py-2">{l.description}{vehicle(l) && <span className="block text-xs text-muted-foreground">{vehicle(l)}</span>}</td>
                <td className="px-3 py-2 text-muted-foreground">{l.receipt_reference || "—"}</td>
                <td className="px-5 py-2 text-right"><Amount value={l.amount} currency={claim.currency} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t font-medium">
              <td colSpan={5} className="px-5 py-2 text-right">Total</td>
              <td className="px-5 py-2 text-right"><Amount value={claim.amount} currency={claim.currency} /></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
