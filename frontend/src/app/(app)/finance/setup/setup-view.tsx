"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Lock, Pencil, Plus, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus, StatusBadge } from "@/components/erp/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { ActionError } from "@/components/finance/action-error";
import { Amount } from "@/components/finance/amount";
import { Cell, LedgerTable, Row } from "@/components/finance/ledger-table";
import { AccountPicker } from "@/components/finance/pickers";
import { useStepUp } from "@/components/shell/step-up";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import {
  type Account, type CostCenter, type FiscalYear, type PostingRule, type SubledgerCheck, postable, useAccounts, useCostCenters,
} from "@/lib/api/finance";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";

const TYPES: Account["account_type"][] = ["asset", "liability", "equity", "income", "expense"];
const SUB_TYPES = ["general", "bank", "cash", "receivable", "payable", "inventory", "tax", "fixed_asset", "accumulated_depreciation", "retained_earnings"] as const;
const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

/** Orders accounts as a tree (parents before children) and returns each one's depth. */
function treeOrder(accounts: Account[]): { account: Account; depth: number }[] {
  const children = new Map<string | null, Account[]>();
  for (const a of accounts) {
    const key = a.parent && accounts.some((x) => x.id === a.parent) ? a.parent : null;
    children.set(key, [...(children.get(key) ?? []), a]);
  }
  const out: { account: Account; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const a of (children.get(parent) ?? []).sort((x, y) => x.code.localeCompare(y.code))) {
      out.push({ account: a, depth });
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function invalidateOn409(error: unknown, refresh: () => void) {
  if (isApiError(error) && error.status === 409) refresh();
}

// --- Chart of accounts --------------------------------------------------------------------------

function AccountDialog({ account, accounts, onDone }: { account?: Account; accounts: Account[]; onDone: () => void }) {
  const { activeCompany } = useSession();
  const { withStepUp } = useStepUp();
  const [open, setOpen] = useState(false);
  const blank = { code: "", name: "", account_type: "expense" as Account["account_type"], sub_type: "general" as NonNullable<Account["sub_type"]>, parent: "", is_group: false, is_control: false, is_active: true };
  const [form, setForm] = useState(blank);
  const save = useMutation({
    mutationFn: () => withStepUp(() => account
      ? unwrap(api.PATCH("/api/v1/finance/accounts/{id}/", { params: { path: { id: account.id } },
        body: { name: form.name, parent: form.parent || null, is_active: form.is_active, is_control: form.is_control, version: account.version } as never }))
      : unwrap(api.POST("/api/v1/finance/accounts/", { body: { ...form, parent: form.parent || null, company: activeCompany!.id } }))),
    onSuccess: () => { setOpen(false); toast(account ? "Account saved" : "Account added"); onDone(); },
    onError: (e) => invalidateOn409(e, onDone),
  });
  const groups = accounts.filter((a) => a.is_group && a.id !== account?.id);
  return (
    <Dialog open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) setForm(account ? { code: account.code, name: account.name, account_type: account.account_type, sub_type: account.sub_type ?? "general", parent: account.parent ?? "", is_group: !!account.is_group, is_control: !!account.is_control, is_active: account.is_active !== false } : blank);
      save.reset();
    }}>
      <DialogTrigger asChild>
        {account ? <Button size="icon-sm" variant="ghost" aria-label={`Edit ${account.code} ${account.name}`}><Pencil aria-hidden /></Button>
          : <Button size="sm"><Plus aria-hidden /> Add account</Button>}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogHeader>
            <DialogTitle>{account ? `Edit ${account.code}` : "Add an account"}</DialogTitle>
            <DialogDescription>{account ? "The code and type are fixed once created; existing postings keep their history." : "Group accounts are headings; only leaf accounts receive postings."}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <Field id="acc-code" label="Code"><Input id="acc-code" className="num" value={form.code} disabled={!!account} required maxLength={20} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
            <Field id="acc-name" label="Name"><Input id="acc-name" value={form.name} required maxLength={150} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="acc-type" label="Type">
              <Select value={form.account_type} disabled={!!account} onValueChange={(v) => setForm({ ...form, account_type: v as Account["account_type"] })}>
                <SelectTrigger id="acc-type" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{TYPES.map((t) => <SelectItem key={t} value={t}>{label(t)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field id="acc-sub" label="Purpose">
              <Select value={form.sub_type} disabled={!!account} onValueChange={(v) => setForm({ ...form, sub_type: v as typeof form.sub_type })}>
                <SelectTrigger id="acc-sub" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{SUB_TYPES.map((t) => <SelectItem key={t} value={t}>{label(t)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
          <Field id="acc-parent" label="Under heading">
            <AccountPicker id="acc-parent" accounts={groups} value={form.parent} onChange={(id) => setForm({ ...form, parent: id })} placeholder="Top level" />
          </Field>
          <div className="grid gap-2">
            {!account && <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.is_group} onCheckedChange={(v) => setForm({ ...form, is_group: v === true })} /> Heading (group) account</label>}
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.is_control} onCheckedChange={(v) => setForm({ ...form, is_control: v === true })} /> Control account (postings must name a customer or supplier)</label>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v === true })} /> Active</label>
          </div>
          <ActionError error={save.error} />
          <DialogFooter><Button type="submit" disabled={save.isPending || !form.code || !form.name}>{account ? "Save" : "Add account"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChartOfAccounts() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["finance", "accounts"] });
  const install = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/finance/accounts/install-template/")),
    onSuccess: (r) => { toast(`${r.accounts} accounts installed`); refresh(); },
  });
  const list = accounts.data ?? [];
  return (
    <Section title="Chart of accounts" description="Headings group accounts for the statements; postings go to the leaf accounts."
      actions={can("finance.account.create") && list.length > 0 && <AccountDialog accounts={list} onDone={refresh} />}>
      {accounts.error ? <ErrorState error={accounts.error} onRetry={accounts.refetch} /> : !accounts.data ? <RowsSkeleton /> :
        list.length === 0 ? (
          <EmptyState title="No chart of accounts yet" description="Start from the template chart (with its posting rules) and adjust it to your business."
            action={can("finance.account.create") && <><Button onClick={() => install.mutate()} disabled={install.isPending}>Install template chart</Button><ActionError error={install.error} className="mt-3" /></>} />
        ) : (
          <LedgerTable caption="Chart of accounts" columns={[{ key: "code", header: "Code" }, { key: "name", header: "Account" }, { key: "type", header: "Type" },
            { key: "purpose", header: "Purpose" }, { key: "flags", header: "" }, { key: "edit", header: <span className="sr-only">Edit</span> }]}>
            {treeOrder(list).map(({ account: a, depth }) => (
              <Row key={a.id} className={cn(a.is_active === false && "opacity-60")}>
                <Cell className={cn(a.is_group && "font-semibold")}>{a.code}</Cell>
                <Cell className={cn("min-w-52 font-sans", a.is_group && "font-semibold")}><span style={{ paddingLeft: `${depth * 1.1}rem` }}>{a.name}</span></Cell>
                <Cell className="font-sans">{label(a.account_type)}</Cell>
                <Cell className="font-sans text-muted-foreground">{a.is_group ? "Heading" : label(a.sub_type ?? "general")}</Cell>
                <Cell><span className="flex gap-1">{a.is_control && <StatusBadge tone="info">Control</StatusBadge>}{a.is_active === false && <StatusBadge tone="neutral">Inactive</StatusBadge>}</span></Cell>
                <Cell>{can("finance.account.update") && <AccountDialog account={a} accounts={list} onDone={refresh} />}</Cell>
              </Row>
            ))}
          </LedgerTable>
        )}
    </Section>
  );
}

// --- Posting rules -------------------------------------------------------------------------------

function RuleDialog({ rule, accounts, onDone }: { rule?: PostingRule; accounts: Account[]; onDone: () => void }) {
  const { activeCompany } = useSession();
  const { withStepUp } = useStepUp();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ key: "", posting_group: "", warehouse_type: "", account: "", is_active: true });
  const save = useMutation({
    mutationFn: () => withStepUp(() => rule
      ? unwrap(api.PATCH("/api/v1/finance/posting-rules/{id}/", { params: { path: { id: rule.id } }, body: { account: form.account, is_active: form.is_active } }))
      : unwrap(api.POST("/api/v1/finance/posting-rules/", { body: { ...form, key: form.key.trim(), company: activeCompany!.id } }))),
    onSuccess: () => { setOpen(false); toast("Posting rule saved"); onDone(); },
  });
  return (
    <Dialog open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) setForm(rule ? { key: rule.key, posting_group: rule.posting_group ?? "", warehouse_type: rule.warehouse_type ?? "", account: rule.account, is_active: rule.is_active !== false } : { key: "", posting_group: "", warehouse_type: "", account: "", is_active: true });
      save.reset();
    }}>
      <DialogTrigger asChild>
        {rule ? <Button size="icon-sm" variant="ghost" aria-label={`Edit rule ${rule.key}`}><Pencil aria-hidden /></Button> : <Button size="sm"><Plus aria-hidden /> Add rule</Button>}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogHeader>
            <DialogTitle>{rule ? `Account for ${rule.key}` : "Add a posting rule"}</DialogTitle>
            <DialogDescription>The most specific active rule wins: item group and warehouse type, then warehouse type, then item group, then the default. Changes need a fresh verification.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="rule-key" label="Posting key"><Input id="rule-key" className="num" value={form.key} disabled={!!rule} required onChange={(e) => setForm({ ...form, key: e.target.value })} /></Field>
            <Field id="rule-group" label="Item group"><Input id="rule-group" value={form.posting_group} disabled={!!rule} placeholder="Any" onChange={(e) => setForm({ ...form, posting_group: e.target.value })} /></Field>
            <Field id="rule-wh" label="Warehouse type"><Input id="rule-wh" value={form.warehouse_type} disabled={!!rule} placeholder="Any" onChange={(e) => setForm({ ...form, warehouse_type: e.target.value })} /></Field>
          </div>
          <Field id="rule-account" label="Ledger account"><AccountPicker id="rule-account" accounts={accounts} value={form.account} onChange={(id) => setForm({ ...form, account: id })} /></Field>
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
            <Label htmlFor="rule-active" className="font-normal">Active</Label>
            <Switch id="rule-active" checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
          </div>
          <ActionError error={save.error} />
          <DialogFooter><Button type="submit" disabled={save.isPending || !form.key || !form.account}>Save rule</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PostingRules() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const rules = useQuery({ queryKey: ["finance", "posting-rules"], queryFn: () => unwrap(api.GET("/api/v1/finance/posting-rules/")) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["finance", "posting-rules"] });
  const leaf = postable(accounts.data);
  const name = (id: string) => accounts.data?.find((a) => a.id === id)?.name ?? "";
  return (
    <Section title="Posting rules" description="Which ledger account each business event posts to (account determination)."
      actions={can("finance.posting_rule.create") && <RuleDialog accounts={leaf} onDone={refresh} />}>
      {rules.error ? <ErrorState error={rules.error} onRetry={rules.refetch} /> : !rules.data ? <RowsSkeleton /> :
        rules.data.length === 0 ? <EmptyState title="No posting rules" description="Install the template chart to get the standard rules." /> : (
          <LedgerTable caption="Posting rules" columns={[{ key: "key", header: "Posting key" }, { key: "group", header: "Item group" }, { key: "wh", header: "Warehouse type" },
            { key: "account", header: "Account" }, { key: "active", header: "Status" }, { key: "edit", header: <span className="sr-only">Edit</span> }]}>
            {rules.data.map((r) => (
              <Row key={r.id}>
                <Cell className="font-medium">{r.key}</Cell>
                <Cell className="text-muted-foreground">{r.posting_group || "Any"}</Cell>
                <Cell className="text-muted-foreground">{r.warehouse_type || "Any"}</Cell>
                <Cell className="min-w-48"><span className="mr-2">{r.account_code}</span><span className="font-sans text-muted-foreground">{name(r.account)}</span></Cell>
                <Cell><ActiveStatus active={r.is_active !== false} /></Cell>
                <Cell>{can("finance.posting_rule.update") && <RuleDialog rule={r} accounts={leaf} onDone={refresh} />}</Cell>
              </Row>
            ))}
          </LedgerTable>
        )}
    </Section>
  );
}

// --- Cost centres --------------------------------------------------------------------------------

function CostCenterDialog({ center, onDone }: { center?: CostCenter; onDone: () => void }) {
  const { activeCompany } = useSession();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", is_active: true });
  const save = useMutation({
    mutationFn: () => center
      ? unwrap(api.PATCH("/api/v1/finance/cost-centers/{id}/", { params: { path: { id: center.id } }, body: { name: form.name, is_active: form.is_active, version: center.version } as never }))
      : unwrap(api.POST("/api/v1/finance/cost-centers/", { body: { ...form, company: activeCompany!.id } })),
    onSuccess: () => { setOpen(false); toast("Cost centre saved"); onDone(); },
    onError: (e) => invalidateOn409(e, onDone),
  });
  return (
    <Dialog open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) setForm(center ? { code: center.code, name: center.name, is_active: center.is_active !== false } : { code: "", name: "", is_active: true });
      save.reset();
    }}>
      <DialogTrigger asChild>
        {center ? <Button size="icon-sm" variant="ghost" aria-label={`Edit ${center.code}`}><Pencil aria-hidden /></Button> : <Button size="sm"><Plus aria-hidden /> Add cost centre</Button>}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogHeader><DialogTitle>{center ? `Edit ${center.code}` : "Add a cost centre"}</DialogTitle><DialogDescription>Journal lines can carry a cost centre for budgets and reporting.</DialogDescription></DialogHeader>
          <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <Field id="cc-code" label="Code"><Input id="cc-code" className="num" value={form.code} disabled={!!center} required maxLength={20} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
            <Field id="cc-name" label="Name"><Input id="cc-name" value={form.name} required maxLength={150} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v === true })} /> Active</label>
          <ActionError error={save.error} />
          <DialogFooter><Button type="submit" disabled={save.isPending || !form.code || !form.name}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CostCenters() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const centers = useCostCenters();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["finance", "cost-centers"] });
  return (
    <Section title="Cost centres" actions={can("finance.cost_center.create") && <CostCenterDialog onDone={refresh} />}>
      {centers.error ? <ErrorState error={centers.error} onRetry={centers.refetch} /> : !centers.data ? <RowsSkeleton /> :
        centers.data.results.length === 0 ? <EmptyState title="No cost centres yet" /> : (
          <LedgerTable caption="Cost centres" columns={[{ key: "code", header: "Code" }, { key: "name", header: "Name" }, { key: "status", header: "Status" }, { key: "edit", header: <span className="sr-only">Edit</span> }]}>
            {centers.data.results.map((c) => (
              <Row key={c.id}>
                <Cell className="font-medium">{c.code}</Cell><Cell className="font-sans">{c.name}</Cell>
                <Cell><ActiveStatus active={c.is_active !== false} /></Cell>
                <Cell>{can("finance.cost_center.update") && <CostCenterDialog center={c} onDone={refresh} />}</Cell>
              </Row>
            ))}
          </LedgerTable>
        )}
    </Section>
  );
}

// --- Period close --------------------------------------------------------------------------------

const CHECK_LABEL: Record<string, string> = { inventory: "Inventory (stock ledger)", receivable: "Receivables (open items)", payable: "Payables (open items)" };

function PeriodClose() {
  const { can, activeCompany } = useSession();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const url = useUrlState();
  const [force, setForce] = useState(false);
  const years = useQuery({
    queryKey: ["organization", "fiscal-years", activeCompany?.id],
    queryFn: () => unwrap(api.GET("/api/v1/organization/fiscal-years/", { params: { query: { company: activeCompany?.id, ordering: "-start_date" } } })),
  });
  const allYears: FiscalYear[] = years.data?.results ?? [];
  const periods = allYears.flatMap((y) => y.periods.map((p) => ({ ...p, year: y })));
  const firstOpen = [...periods].sort((a, b) => a.start_date.localeCompare(b.start_date)).find((p) => p.status !== "closed");
  const periodId = url.get("period") || firstOpen?.id || "";
  const period = periods.find((p) => p.id === periodId);
  const checks = useQuery({
    queryKey: ["finance", "close-checks", period?.end_date],
    queryFn: async () => (await unwrap(api.GET("/api/v1/finance/close/checks/", { params: { query: { as_of: period!.end_date } } }))) as unknown as SubledgerCheck[],
    enabled: !!period,
  });
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ["organization", "fiscal-years"] }); queryClient.invalidateQueries({ queryKey: ["finance", "close-checks"] }); };
  const closePeriod = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/finance/close/period/", { body: { period: period!.id, force } }))),
    onSuccess: () => { toast("Period closed"); setForce(false); refresh(); },
  });
  const closeYear = useMutation({
    mutationFn: (fy: FiscalYear) => withStepUp(() => unwrap(api.POST("/api/v1/finance/close/year/", { body: { fiscal_year: fy.id } }))),
    onSuccess: () => { toast("Fiscal year closed; the closing entry moved the year's result to retained earnings"); refresh(); },
  });
  const allOk = checks.data?.every((c) => c.ok) ?? false;
  const canManage = can("finance.period.manage");

  if (years.error) return <Section><ErrorState error={years.error} onRetry={years.refetch} /></Section>;
  if (!years.data) return <Section><RowsSkeleton /></Section>;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <Section title="Fiscal periods" description="Close periods in order. A closed period accepts no postings in any sub-ledger.">
        {allYears.length === 0 ? <EmptyState title="No fiscal years" /> : allYears.map((fy) => (
          <div key={fy.id} className="border-b last:border-0">
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <p className="font-medium">{fy.code} <span className="ml-1 text-sm font-normal text-muted-foreground">{date(fy.start_date)} – {date(fy.end_date)}</span></p>
              <span className="flex items-center gap-2">
                <StatusBadge tone={fy.status === "closed" ? "neutral" : "approved"}>{label(fy.status)}</StatusBadge>
                {canManage && fy.status !== "closed" && (
                  <Button size="sm" variant="outline" disabled={closeYear.isPending} onClick={() => closeYear.mutate(fy)}><Lock aria-hidden /> Close year</Button>
                )}
              </span>
            </div>
            <ul className="grid grid-cols-3 gap-1.5 px-5 pb-4 sm:grid-cols-4">
              {fy.periods.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => url.set({ period: p.id })} aria-current={p.id === periodId ? "true" : undefined}
                    className={cn("w-full rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/60",
                      p.id === periodId && "border-foreground/60 shadow-[inset_0_-2px_0_var(--marking)]")}>
                    <span className="num block font-medium">P{p.period_no} · {date(p.start_date).replace(/^\d+ /, "")}</span>
                    <span className={cn("block", p.status === "closed" ? "text-muted-foreground" : "text-status-approved")}>{p.status === "closed" ? "Closed" : label(p.status)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="px-5 pb-4"><ActionError error={closeYear.error} /></div>
      </Section>
      <Section title={period ? `Close P${period.period_no} (${date(period.start_date)} – ${date(period.end_date)})` : "Choose a period"}
        description="Sub-ledgers are reconciled to their ledger control accounts as of the period end before anything is locked.">
        {!period ? <EmptyState title="Choose a period" /> : checks.error ? <ErrorState error={checks.error} onRetry={checks.refetch} /> : !checks.data ? <RowsSkeleton rows={3} /> : (
          <div className="grid gap-4 pb-4">
            <LedgerTable caption="Sub-ledger reconciliation" columns={[{ key: "check", header: "Sub-ledger" }, { key: "sub", header: "Sub-ledger", align: "right" },
              { key: "gl", header: "General ledger", align: "right" }, { key: "diff", header: "Difference", align: "right" }, { key: "ok", header: "" }]}>
              {checks.data.map((c) => (
                <Row key={c.check}>
                  <Cell className="font-sans font-medium">{CHECK_LABEL[c.check] ?? c.check}</Cell>
                  <Cell align="right"><Amount value={c.subledger} /></Cell>
                  <Cell align="right"><Amount value={c.gl} /></Cell>
                  <Cell align="right"><Amount value={c.difference} muteZero /></Cell>
                  <Cell>{c.ok ? <CheckCircle2 className="size-4 text-status-approved" aria-label="Agrees" /> : <XCircle className="size-4 text-status-rejected" aria-label="Differs" />}</Cell>
                </Row>
              ))}
            </LedgerTable>
            {period.status === "closed" ? (
              <p className="px-5 text-sm text-muted-foreground">This period is closed.</p>
            ) : canManage ? (
              <div className="grid gap-3 px-5">
                {!allOk && (
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} className="mt-0.5" />
                    <span>Close despite the differences above. The override and the figures are recorded in the audit log.</span>
                  </label>
                )}
                <div><Button disabled={closePeriod.isPending || (!allOk && !force)} onClick={() => closePeriod.mutate()}><Lock aria-hidden /> Close period</Button></div>
                <ActionError error={closePeriod.error} />
              </div>
            ) : <p className="px-5 text-sm text-muted-foreground">You can review the reconciliation; closing needs period-close rights.</p>}
          </div>
        )}
      </Section>
    </div>
  );
}

export function SetupView() {
  const { can } = useSession();
  const url = useUrlState();
  const tabs = [
    can("finance.account.read") && ["accounts", "Chart of accounts"],
    can("finance.posting_rule.read") && ["rules", "Posting rules"],
    can("finance.cost_center.read") && ["cost-centres", "Cost centres"],
    can("finance.period.read") && ["close", "Period close"],
  ].filter(Boolean) as [string, string][];
  const view = url.get("view") || tabs[0]?.[0] || "accounts";
  return (
    <>
      <PageHeader title="Accounting setup" description="The chart of accounts, how business events post to it, cost centres, and closing periods." />
      <Tabs value={view} onValueChange={(v) => url.set({ view: v, period: null })} className="mb-4">
        <div className="max-w-full overflow-x-auto">
          <TabsList>{tabs.map(([k, l]) => <TabsTrigger key={k} value={k}>{l}</TabsTrigger>)}</TabsList>
        </div>
      </Tabs>
      {view === "accounts" && <ChartOfAccounts />}
      {view === "rules" && <PostingRules />}
      {view === "cost-centres" && <CostCenters />}
      {view === "close" && <PeriodClose />}
    </>
  );
}
