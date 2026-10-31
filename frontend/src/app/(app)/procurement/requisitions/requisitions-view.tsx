"use client";

import { useQuery } from "@tanstack/react-query";
import { Inbox, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ActionError, DocStatus, Money, today } from "@/components/trade/common";
import { add, dec, fixed, lineTaxable } from "@/components/trade/decimal";
import { FormSheet, StatusFilter, useTradeAction } from "@/components/trade/layout";
import { LineEditor } from "@/components/trade/line-editor";
import { BranchSelect, ItemPicker, UomSelect, WarehouseSelect } from "@/components/trade/pickers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { tradeKey, useCompanyScopes } from "@/lib/api/trade";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

type PR = components["schemas"]["PurchaseRequisition"];
type Line = { item: string; itemLabel: string | null; units: (string | null | undefined)[]; quantity: string; uom: string; estimated_rate: string; warehouse: string };
const NONE = "__none__";
const blank = (warehouse = ""): Line => ({ item: "", itemLabel: null, units: [], quantity: "", uom: "", estimated_rate: "", warehouse });

export const PR_STATUSES: [string, string][] = [["", "Any status"], ["draft", "Draft"], ["submitted", "Submitted"], ["approved", "Approved"], ["rejected", "Rejected"]];

function NewRequisition({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const scopes = useCompanyScopes();
  const [form, setForm] = useState({ branch: "", department: NONE, needed_by: today(7), purpose: "" });
  const [lines, setLines] = useState<Line[]>([blank()]);
  const estimate = add(...lines.map((l) => lineTaxable(l.quantity, l.estimated_rate || "0", "0") ?? BigInt(0)));
  const ready = form.branch && form.purpose.trim() && lines.every((l) => l.item && dec(l.quantity) && l.uom && l.warehouse);
  const create = useTradeAction(() =>
    unwrap(api.POST("/api/v1/procurement/requisitions/", {
      body: {
        company: scopes.companyId, branch: form.branch, department: form.department === NONE ? null : form.department,
        needed_by: form.needed_by, purpose: form.purpose,
        lines: lines.map((l) => ({ item: l.item, quantity: l.quantity, uom: l.uom, estimated_rate: l.estimated_rate || "0", warehouse: l.warehouse })),
      },
    })),
  (pr) => { toast(`Requisition ${pr.number} saved as draft`); onOpenChange(false); router.push(`/procurement/requisitions/${pr.id}`); });

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title="New purchase requisition" description="Saved as a draft. Submit it for approval from the requisition page.">
      <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
        <ActionError error={create.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="pr-branch" label="Branch"><BranchSelect id="pr-branch" value={form.branch} onChange={(v) => { setForm({ ...form, branch: v }); setLines(lines.map((l) => ({ ...l, warehouse: "" }))); }} /></Field>
          <Field id="pr-dept" label="Department">
            <Select value={form.department} onValueChange={(v) => setForm({ ...form, department: v })}>
              <SelectTrigger id="pr-dept" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>No department</SelectItem>{scopes.departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="pr-needed" label="Needed by"><Input id="pr-needed" type="date" value={form.needed_by} onChange={(e) => setForm({ ...form, needed_by: e.target.value })} required /></Field>
          <Field id="pr-purpose" label="Purpose"><Input id="pr-purpose" value={form.purpose} maxLength={300} onChange={(e) => setForm({ ...form, purpose: e.target.value })} required /></Field>
        </div>
        <div className="grid gap-2">
          <p className="type-section">Items</p>
          <LineEditor idPrefix="pr-line" lines={lines} onChange={setLines} blank={() => blank()} columns={[
            { key: "item", label: "Item", width: "minmax(12rem,2fr)", wide: true, render: (l, u, id) => (
              <ItemPicker id={id} purpose="purchase" value={l.item} label={l.itemLabel}
                onChange={(i) => u({ item: i.id, itemLabel: `${i.code} ${i.name}`, units: [i.stock_uom, i.purchase_uom], uom: i.purchase_uom ?? i.stock_uom })} />) },
            { key: "qty", label: "Quantity", width: "6rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.quantity} onChange={(e) => u({ quantity: e.target.value })} /> },
            { key: "uom", label: "Unit", width: "6rem", render: (l, u, id) => <UomSelect id={id} value={l.uom} allowed={l.units} onChange={(v) => u({ uom: v })} /> },
            { key: "rate", label: "Est. rate", width: "7rem", render: (l, u, id) => <Input id={id} inputMode="decimal" className="num" value={l.estimated_rate} onChange={(e) => u({ estimated_rate: e.target.value })} /> },
            { key: "wh", label: "Deliver to", width: "minmax(9rem,1.2fr)", wide: true, render: (l, u, id) => <WarehouseSelect id={id} branchId={form.branch || undefined} value={l.warehouse} onChange={(v) => u({ warehouse: v })} /> },
          ]} footer={<p className="text-sm text-muted-foreground">Estimate: <span className="num font-medium text-foreground">₹{fixed(estimate, 2)}</span></p>} />
        </div>
        <Button type="submit" disabled={!ready || create.isPending}>Save draft</Button>
      </form>
    </FormSheet>
  );
}

export function RequisitionsView() {
  const { can } = useSession();
  const url = useUrlState();
  const status = url.get("status");
  const [open, setOpen] = useState(false);
  const scopes = useCompanyScopes();
  const query = useQuery({
    queryKey: tradeKey("requisitions", status, url.page),
    queryFn: () => unwrap(api.GET("/api/v1/procurement/requisitions/", { params: { query: { status: status || undefined, page: url.page } } })),
  });
  const columns: Column<PR>[] = [
    { key: "number", header: "Requisition", cell: (r) => <span><span className="num block">{r.number}</span><span className="block max-w-[36ch] truncate text-xs font-normal text-muted-foreground">{r.purpose}</span></span> },
    { key: "branch", header: "Branch", cell: (r) => scopes.name(r.branch) },
    { key: "needed", header: "Needed by", cell: (r) => date(r.needed_by) },
    { key: "lines", header: "Lines", align: "right", cell: (r) => <span className="num">{r.lines.length}</span> },
    { key: "amount", header: "Estimate", align: "right", cell: (r) => <Money value={r.amount} /> },
    { key: "status", header: "Status", cell: (r) => <DocStatus status={r.status} /> },
  ];
  return (
    <>
      <PageHeader title="Purchase requisitions" description="Requests to buy. Approved requisitions go out for quotation or straight to a purchase order."
        actions={can("procurement.purchase_requisition.create") && <Button onClick={() => setOpen(true)}><Plus aria-hidden /> New requisition</Button>} />
      <Section actions={<StatusFilter value={status} options={PR_STATUSES} onChange={(v) => url.set({ status: v })} />}>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(r) => `/procurement/requisitions/${r.id}`} caption="Purchase requisitions"
          empty={<EmptyState icon={Inbox} title="No requisitions" description="Raise a requisition when stores or a department needs material." />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
      <NewRequisition open={open} onOpenChange={setOpen} />
    </>
  );
}
