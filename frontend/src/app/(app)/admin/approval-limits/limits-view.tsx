"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Scale } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/erp/data-table";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { useRoles } from "@/lib/api/hooks";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";

type Limit = components["schemas"]["ApprovalLimit"];
const ALL = "__all__";

function SetLimit() {
  const { me } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const roles = useRoles();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ role: "", company: ALL, document_type: "", currency: "INR", max_amount: "" });
  const save = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/authorization/approval-limits/", {
      body: { ...form, company: form.company === ALL ? null : form.company },
    }))),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["authorization", "limits"] }); toast("Approval limit saved"); setOpen(false); },
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus aria-hidden /> Set a limit</Button></DialogTrigger>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogHeader><DialogTitle>Set an approval limit</DialogTitle>
            <DialogDescription>The highest amount a role may give final approval for. A role with no limit can&apos;t give final approval at all. Setting the same role, document and company again replaces the old limit.</DialogDescription></DialogHeader>
          <FormError message={errors._form} />
          <Field id="role" label="Role" error={errors.role}>
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
              <SelectTrigger id="role" className="w-full"><SelectValue placeholder="Choose a role" /></SelectTrigger>
              <SelectContent>{roles.data?.results.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="doc" label="Document type" error={errors.document_type} hint="As module.resource, e.g. procurement.purchase_order">
            <Input id="doc" className="num" value={form.document_type} onChange={(e) => setForm({ ...form, document_type: e.target.value })} required />
          </Field>
          <Field id="company" label="Company">
            <Select value={form.company} onValueChange={(v) => setForm({ ...form, company: v })}>
              <SelectTrigger id="company" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Every company</SelectItem>
                {me.companies.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
            <Field id="currency" label="Currency"><Input id="currency" value={form.currency} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></Field>
            <Field id="amount" label="Maximum amount" error={errors.max_amount}>
              <Input id="amount" inputMode="decimal" className="num" value={form.max_amount} onChange={(e) => setForm({ ...form, max_amount: e.target.value })} required />
            </Field>
          </div>
          <DialogFooter><Button type="submit" disabled={!form.role || !form.document_type || !form.max_amount || save.isPending}>Save limit</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LimitsView() {
  const { can, me } = useSession();
  const roles = useRoles();
  const query = useQuery({ queryKey: ["authorization", "limits"], queryFn: () => unwrap(api.GET("/api/v1/authorization/approval-limits/", { params: { query: { page_size: 200 } } })) });
  const roleName = (id: string) => roles.data?.results.find((r) => r.id === id)?.name ?? "—";
  const columns: Column<Limit>[] = [
    { key: "doc", header: "Document type", cell: (l) => <span className="num">{l.document_type}</span> },
    { key: "role", header: "Role", cell: (l) => roleName(l.role) },
    { key: "company", header: "Company", cell: (l) => l.company ? me.companies.find((c) => c.id === l.company)?.name ?? "Other company" : "Every company" },
    { key: "max", header: "Up to", align: "right", cell: (l) => <span className="num font-medium">{money(l.max_amount, l.currency)}</span> },
    { key: "status", header: "Status", cell: (l) => <ActiveStatus active={l.is_active} /> },
  ];
  return (
    <>
      <PageHeader title="Approval limits" description="How much each role may approve. Limits apply at the final step of an approval route." actions={can("authorization.approval_limit.manage") && <SetLimit />} />
      <Section>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          empty={<EmptyState icon={Scale} title="No limits set" description="Until limits are set, no role can give final approval on amount-based documents." />} />
      </Section>
    </>
  );
}
