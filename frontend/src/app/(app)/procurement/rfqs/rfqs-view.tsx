"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ActionError, DocStatus, today } from "@/components/trade/common";
import { dec, trim } from "@/components/trade/decimal";
import { FormSheet, StatusFilter, useTradeAction } from "@/components/trade/layout";
import { LineEditor } from "@/components/trade/line-editor";
import { BranchSelect, ItemPicker, PartnerPicker, UomSelect } from "@/components/trade/pickers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes, usePartnerIndex, useUoms, type Partner } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type RFQ = components["schemas"]["PurchaseRFQ"];
type Line = { item: string; itemLabel: string | null; units: (string | null | undefined)[]; quantity: string; uom: string };
const DIRECT = "__direct__";
const blank = (): Line => ({ item: "", itemLabel: null, units: [], quantity: "", uom: "" });

function NewRFQ({ open, onOpenChange, initialRequisition }: { open: boolean; onOpenChange: (o: boolean) => void; initialRequisition: string }) {
  const router = useRouter();
  const scopes = useCompanyScopes();
  const uoms = useUoms();
  const [form, setForm] = useState({ branch: "", requisition: initialRequisition || DIRECT, respond_by: today(7), notes: "" });
  const [suppliers, setSuppliers] = useState<Partner[]>([]);
  const [lines, setLines] = useState<Line[]>([blank()]);
  const approved = useQuery({
    queryKey: tradeKey("requisitions", "approved"),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/requisitions/", { params: { query: { status: "approved", page_size: 100 } } })),
    enabled: open,
  });
  const pr = approved.data?.results.find((r) => r.id === form.requisition);
  const branch = pr ? pr.branch : form.branch;
  const fromPr = form.requisition !== DIRECT;
  const ready = branch && suppliers.length > 0 && (fromPr ? !!pr : lines.every((l) => l.item && dec(l.quantity) && l.uom));
  const create = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/rfqs/", {
      body: {
        company: scopes.companyId, branch, respond_by: form.respond_by, notes: form.notes, suppliers: suppliers.map((s) => s.id),
        requisition: fromPr ? form.requisition : null,
        // Always send lines: an empty list asks the server to copy the requisition's lines.
        lines: fromPr ? [] : lines.map((l) => ({ item: l.item, quantity: l.quantity, uom: l.uom })),
      },
    })),
  (rfq) => { toast(`${rfq.number} created`); onOpenChange(false); router.push(`/procurement/rfqs/${rfq.id}`); });

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title="New request for quotation" description="Invite suppliers to quote. Record their quotations on the RFQ page and compare them.">
      <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
        <ActionError error={create.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="rfq-source" label="Source" className="sm:col-span-2">
            <Select value={form.requisition} onValueChange={(v) => setForm({ ...form, requisition: v })}>
              <SelectTrigger id="rfq-source" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={DIRECT}>Items entered here</SelectItem>
                {approved.data?.results.map((r) => <SelectItem key={r.id} value={r.id}>{r.number} · {r.purpose}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          {!fromPr && <Field id="rfq-branch" label="Branch"><BranchSelect id="rfq-branch" value={form.branch} onChange={(v) => setForm({ ...form, branch: v })} /></Field>}
          <Field id="rfq-respond" label="Quotes due by"><Input id="rfq-respond" type="date" value={form.respond_by} onChange={(e) => setForm({ ...form, respond_by: e.target.value })} required /></Field>
        </div>
        <div className="grid gap-2">
          <p className="type-section">Suppliers invited</p>
          <ul className="flex flex-wrap gap-2" aria-label="Invited suppliers">
            {suppliers.map((s) => (
              <li key={s.id} className="flex items-center gap-1 rounded-md border bg-muted px-2 py-1 text-sm">
                {s.name}
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${s.name}`} onClick={() => setSuppliers(suppliers.filter((x) => x.id !== s.id))}><X /></Button>
              </li>
            ))}
          </ul>
          <div className="max-w-sm">
            <PartnerPicker id="rfq-supplier" kind="supplier" value="" label={null} ariaLabel="Invite a supplier"
              onChange={(p) => !suppliers.some((s) => s.id === p.id) && setSuppliers([...suppliers, p])} />
          </div>
        </div>
        <div className="grid gap-2">
          <p className="type-section">Items</p>
          {fromPr ? (
            pr ? (
              <ul className="grid gap-1 rounded-md border px-3 py-2 text-sm">
                {pr.lines.map((l) => <li key={l.id} className="flex justify-between gap-4"><span className="num">{l.item_code}</span><span className="num">{trim(l.quantity)} {uoms.code(l.uom)}</span></li>)}
              </ul>
            ) : <p className="text-sm text-muted-foreground">Loading the requisition…</p>
          ) : (
            <LineEditor idPrefix="rfq-line" lines={lines} onChange={setLines} blank={blank} columns={[
              { key: "item", label: "Item", width: "minmax(12rem,2fr)", wide: true, render: (l, u, id) => (
                <ItemPicker id={id} purpose="purchase" value={l.item} label={l.itemLabel}
                  onChange={(i) => u({ item: i.id, itemLabel: `${i.code} ${i.name}`, units: [i.stock_uom, i.purchase_uom], uom: i.purchase_uom ?? i.stock_uom })} />) },
              { key: "qty", label: "Quantity", width: "7rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.quantity} onChange={(e) => u({ quantity: e.target.value })} /> },
              { key: "uom", label: "Unit", width: "7rem", render: (l, u, id) => <UomSelect id={id} value={l.uom} allowed={l.units} onChange={(v) => u({ uom: v })} /> },
            ]} />
          )}
        </div>
        <Field id="rfq-notes" label="Notes to suppliers"><Textarea id="rfq-notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <Button type="submit" disabled={!ready || create.isPending}>Create RFQ</Button>
      </form>
    </FormSheet>
  );
}

export function RfqsView() {
  const { can } = useSession();
  const url = useUrlState();
  const status = url.get("status");
  const open = url.get("new") === "1";
  const suppliers = usePartnerIndex("supplier");
  const scopes = useCompanyScopes();
  const query = useQuery({
    queryKey: tradeKey("rfqs", status, url.page),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/rfqs/", { params: { query: { status: status || undefined, page: url.page } } })),
  });
  const columns: Column<RFQ>[] = [
    { key: "number", header: "RFQ", cell: (r) => <span className="num">{r.number}</span> },
    { key: "branch", header: "Branch", cell: (r) => scopes.name(r.branch) },
    { key: "suppliers", header: "Suppliers", cell: (r) => <span className="block max-w-[32ch] truncate">{r.suppliers.map((s) => suppliers.name(s)).join(", ")}</span> },
    { key: "lines", header: "Items", align: "right", cell: (r) => <span className="num">{r.lines?.length ?? 0}</span> },
    { key: "due", header: "Quotes due", cell: (r) => date(r.respond_by) },
    { key: "status", header: "Status", cell: (r) => <DocStatus status={r.status} /> },
  ];
  return (
    <>
      <PageHeader title="Requests for quotation" description="Collect supplier quotations, compare them on price, lead time and rating, and turn the chosen one into a purchase order."
        actions={can("procurement.rfq.create") && <Button onClick={() => url.set({ new: 1 })}><Plus aria-hidden /> New RFQ</Button>} />
      <Section actions={<StatusFilter value={status} options={[["", "Any status"], ["open", "Open"], ["closed", "Closed"]]} onChange={(v) => url.set({ status: v })} />}>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(r) => `/procurement/rfqs/${r.id}`} caption="Requests for quotation"
          empty={<EmptyState icon={FileText} title="No RFQs" description="Start one from an approved requisition or by listing items." />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
      {open && <NewRFQ open onOpenChange={(o) => !o && url.set({ new: null, requisition: null })} initialRequisition={url.get("requisition")} />}
    </>
  );
}
