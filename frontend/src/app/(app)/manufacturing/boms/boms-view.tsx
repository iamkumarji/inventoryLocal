"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { ActiveStatus } from "@/components/erp/status";
import { EmptyState } from "@/components/erp/states";
import { ActionDialog } from "@/components/production/action-dialog";
import { ItemPicker, type ItemRef } from "@/components/production/pickers";
import { StateBadge } from "@/components/production/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { type Bom } from "@/lib/api/production";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

function NewBom() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState<ItemRef | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/manufacturing/boms/", { body: { item: item!.id, code, name, is_active: true } })),
    onSuccess: (bom) => {
      queryClient.invalidateQueries({ queryKey: ["manufacturing", "boms"] });
      toast(`${bom.code} created. Add its first version.`);
      setOpen(false);
      router.push(`/manufacturing/boms/${bom.id}`);
    },
  });
  const errors = isApiError(create.error) ? create.error.fieldErrors() : {};
  return (
    <ActionDialog open={open} onOpenChange={setOpen} trigger={<Button><Plus aria-hidden /> New BOM</Button>}
      title="New bill of materials" description="A BOM belongs to one manufactured item. Components and routing live in its versions."
      submitLabel="Create BOM" pending={create.isPending} error={create.error} disabled={!item || !code || !name} onSubmit={() => create.mutate()}>
      <Field id="bom-item" label="Manufactured item" error={errors.item}>
        <ItemPicker id="bom-item" manufactured value={item} onChange={(i) => { setItem(i); if (i && !code) setCode(`BOM-${i.code}`); if (i && !name) setName(i.name); }} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="bom-code" label="BOM code" error={errors.code}><Input id="bom-code" className="num" value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
        <Field id="bom-name" label="Name" error={errors.name}><Input id="bom-name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
      </div>
    </ActionDialog>
  );
}

function latest(bom: Bom) {
  return [...bom.versions].sort((a, b) => b.version_no - a.version_no)[0];
}

export function BomsView() {
  const { can } = useSession();
  const url = useUrlState();
  const search = url.get("q");
  const [draft, setDraft] = useState(search);
  const query = useQuery({
    queryKey: ["manufacturing", "boms", search, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/manufacturing/boms/", { params: { query: { search: search || undefined, page: url.page } } })),
  });
  const columns: Column<Bom>[] = [
    { key: "code", header: "BOM", cell: (b) => <span><span className="num block">{b.code}</span><span className="block text-xs font-normal text-muted-foreground">{b.name}</span></span> },
    { key: "item", header: "Item", cell: (b) => <span className="num">{b.item_code}</span> },
    {
      key: "version", header: "Latest version", cell: (b) => {
        const v = latest(b);
        return v ? <span className="inline-flex items-center gap-2"><span className="num">v{v.version_no}</span><StateBadge kind="bomVersion" value={v.status} /></span> : <span className="text-muted-foreground">No versions</span>;
      },
    },
    { key: "active", header: "Status", className: "hidden sm:table-cell", cell: (b) => <ActiveStatus active={b.is_active ?? true} /> },
  ];
  return (
    <>
      <PageHeader title="Bills of materials" description="Components and routings per manufactured item, versioned and approved by a second person."
        actions={can("manufacturing.bom.create") && <NewBom />} />
      <Section actions={
        <form onSubmit={(e) => { e.preventDefault(); url.set({ q: draft }); }} className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="BOM or item code" className="h-9 w-full pl-8 sm:w-56" aria-label="Search BOMs" />
        </form>
      }>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(b) => `/manufacturing/boms/${b.id}`}
          empty={<EmptyState icon={GitBranch} title={search ? "No BOM matches" : "No bills of materials yet"} description="Create a BOM for each item you manufacture." />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
