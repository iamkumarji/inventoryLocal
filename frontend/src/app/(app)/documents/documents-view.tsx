"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, FolderOpen, Scale, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { fileSize } from "@/components/collaboration/record-panel";
import { DataTable, PageNav, type Column } from "@/components/erp/data-table";
import { Field } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import { EmptyState } from "@/components/erp/states";
import { ActionDialog } from "@/components/production/action-dialog";
import { StateBadge } from "@/components/production/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { useOrgPlaces, type ErpDocument } from "@/lib/api/production";
import { ago } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useUrlState } from "@/lib/use-url-state";

export const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.docx,.csv,.txt";
export const CONFIDENTIALITY = {
  internal: "Internal: anyone with document access",
  restricted: "Restricted: creator and people granted access",
  confidential: "Confidential: only people granted access",
} as const;

function Upload() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { companyId } = useOrgPlaces();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState({ title: "", category: "", description: "", confidentiality: "internal" as keyof typeof CONFIDENTIALITY, retention_until: "" });
  const upload = useMutation({
    mutationFn: () => {
      const body = new FormData();
      body.append("file", file!);
      body.append("title", form.title);
      body.append("category", form.category);
      body.append("description", form.description);
      body.append("confidentiality", form.confidentiality);
      if (form.retention_until) body.append("retention_until", form.retention_until);
      if (companyId) body.append("company", companyId);
      return unwrap(api.POST("/api/v1/documents/documents/", {
        body: body as unknown as components["schemas"]["DocumentCreateRequest"],
        headers: { "Idempotency-Key": idempotencyKey() },
      }));
    },
    onSuccess: (doc) => {
      queryClient.invalidateQueries({ queryKey: ["documents", "library"] });
      toast(`${doc.title} uploaded`);
      // Next keeps the library mounted; close and clear the dialog so it isn't open when the user comes back.
      setOpen(false);
      setFile(null);
      setForm({ title: "", category: "", description: "", confidentiality: "internal", retention_until: "" });
      router.push(`/documents/${doc.id}`);
    },
  });
  const errors = isApiError(upload.error) ? upload.error.fieldErrors() : {};
  return (
    <ActionDialog open={open} onOpenChange={setOpen} trigger={<Button><FileUp aria-hidden /> Upload</Button>}
      title="Upload a document" description="PDF, images, Excel, Word, CSV or text, up to 25 MB. Every version is kept."
      submitLabel="Upload" pending={upload.isPending} error={upload.error} disabled={!file || !form.title.trim()} onSubmit={() => upload.mutate()}>
      <Field id="doc-file" label="File" error={errors.file}>
        <Input id="doc-file" type="file" accept={ACCEPT} className="h-10 py-1.5"
          onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !form.title) setForm({ ...form, title: f.name.replace(/\.[^.]+$/, "") }); }} />
      </Field>
      <Field id="doc-title" label="Title" error={errors.title}><Input id="doc-title" className="h-10" maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="doc-category" label="Category" error={errors.category} hint="e.g. drawing, certificate, contract"><Input id="doc-category" className="h-10" maxLength={60} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
        <Field id="doc-retention" label="Keep until" error={errors.retention_until} hint="Can't be deleted before this date."><Input id="doc-retention" type="date" className="h-10" value={form.retention_until} onChange={(e) => setForm({ ...form, retention_until: e.target.value })} /></Field>
      </div>
      <Field id="doc-confidentiality" label="Confidentiality" error={errors.confidentiality}>
        <Select value={form.confidentiality} onValueChange={(v) => setForm({ ...form, confidentiality: v as keyof typeof CONFIDENTIALITY })}>
          <SelectTrigger id="doc-confidentiality" className="h-10 w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(CONFIDENTIALITY).map(([k, label]) => <SelectItem key={k} value={k}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field id="doc-description" label="Description" error={errors.description}><Textarea id="doc-description" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
    </ActionDialog>
  );
}

export function DocumentsView() {
  const { can } = useSession();
  const url = useUrlState();
  const category = url.get("category");
  const [draft, setDraft] = useState(category);
  const query = useQuery({
    queryKey: ["documents", "library", category, url.page],
    queryFn: () => unwrap(api.GET("/api/v1/documents/documents/", { params: { query: { category: category || undefined, page: url.page } } })),
  });
  const columns: Column<ErpDocument>[] = [
    { key: "title", header: "Document", cell: (d) => <span className="block max-w-[40ch]"><span className="block truncate">{d.title}</span><span className="block truncate text-xs font-normal text-muted-foreground">{d.current_version?.filename}</span></span> },
    { key: "confidentiality", header: "Access", cell: (d) => <StateBadge kind="confidentiality" value={d.confidentiality} /> },
    { key: "version", header: "Version", align: "right", className: "hidden sm:table-cell", cell: (d) => <span className="num">v{d.current_version?.version_no ?? "—"}</span> },
    { key: "size", header: "Size", align: "right", className: "hidden md:table-cell", cell: (d) => <span className="num">{d.current_version ? fileSize(d.current_version.size) : "—"}</span> },
    { key: "category", header: "Category", className: "hidden md:table-cell", cell: (d) => d.category || <span className="text-muted-foreground">—</span> },
    { key: "hold", header: "Hold", className: "hidden lg:table-cell", cell: (d) => (d.legal_hold ? <span className="inline-flex items-center gap-1 text-status-pending"><Scale className="size-3.5" aria-hidden /> Legal hold</span> : null) },
    { key: "updated", header: "Updated", className: "hidden lg:table-cell", cell: (d) => <span className="text-muted-foreground">{ago(d.updated_at)}</span> },
  ];
  return (
    <>
      <PageHeader title="Documents" description="The company library. Files attached to records are on those records." actions={can("documents.document.create") && <Upload />} />
      <Section actions={
        <form onSubmit={(e) => { e.preventDefault(); url.set({ category: draft.trim() }); }} className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Category (exact)" className="h-9 w-full pl-8 sm:w-52" aria-label="Filter by category" />
        </form>
      }>
        <DataTable columns={columns} rows={query.data?.results} isLoading={query.isLoading} error={query.error} onRetry={query.refetch}
          rowHref={(d) => `/documents/${d.id}`} empty={<EmptyState icon={FolderOpen} title={category ? "No documents in this category" : "No documents yet"} />} />
        {query.data && <PageNav page={url.page} count={query.data.count} pageSize={50} onPage={(page) => url.set({ page })} />}
      </Section>
    </>
  );
}
