"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileUp, Pencil, Scale, Shield, Trash2, UserPlus, X } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { downloadDocument, fileSize, RecordPanel } from "@/components/collaboration/record-panel";
import { Field, FormError } from "@/components/erp/field";
import { PageHeader, Section } from "@/components/erp/page-header";
import type { Person } from "@/components/erp/person-picker";
import { ErrorState, PageSkeleton } from "@/components/erp/states";
import { useStepUp } from "@/components/shell/step-up";
import { ActionDialog, Facts } from "@/components/production/action-dialog";
import { PersonField } from "@/components/production/pickers";
import { StateBadge } from "@/components/production/status";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { problemMessage, rememberPerson, usePersonLabel, type ErpDocument } from "@/lib/api/production";
import { date, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

import { ACCEPT, CONFIDENTIALITY } from "../documents-view";

type Saved = (doc: ErpDocument, message: string) => void;

function NewVersion({ doc, onSaved, onFail }: { doc: ErpDocument; onSaved: Saved; onFail: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: () => {
      const body = new FormData();
      body.append("file", file!);
      body.append("version", String(doc.version));
      return unwrap(api.POST("/api/v1/documents/documents/{id}/versions/", {
        params: { path: { id: doc.id } },
        body: body as unknown as components["schemas"]["NewVersionRequest"],
      }));
    },
    onSuccess: (d) => { onSaved(d, `Version ${d.current_version?.version_no} uploaded`); setOpen(false); setFile(null); },
    onError: onFail,
  });
  return (
    <ActionDialog open={open} onOpenChange={setOpen} trigger={<Button><FileUp aria-hidden /> New version</Button>}
      title="Upload a new version" description="The new file becomes current. Earlier versions stay available and can't be changed."
      submitLabel="Upload version" pending={upload.isPending} error={upload.error} disabled={!file} onSubmit={() => upload.mutate()}>
      <Field id="nv-file" label="File"><Input id="nv-file" type="file" accept={ACCEPT} className="h-10 py-1.5" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
    </ActionDialog>
  );
}

function EditMetadata({ doc, onSaved, onFail }: { doc: ErpDocument; onSaved: Saved; onFail: () => void }) {
  const [open, setOpen] = useState(false);
  const initial = () => ({ title: doc.title, category: doc.category, description: doc.description, confidentiality: doc.confidentiality });
  const [form, setForm] = useState(initial);
  const save = useMutation({
    mutationFn: () => unwrap(api.PATCH("/api/v1/documents/documents/{id}/", { params: { path: { id: doc.id } }, body: { ...form, version: doc.version } })),
    onSuccess: (d) => { onSaved(d, "Details saved"); setOpen(false); },
    onError: onFail,
  });
  return (
    <ActionDialog open={open} onOpenChange={(next) => { if (next) setForm(initial()); setOpen(next); }} trigger={<Button variant="outline"><Pencil aria-hidden /> Edit details</Button>}
      title="Edit document details" submitLabel="Save" pending={save.isPending} error={save.error} disabled={!form.title.trim()} onSubmit={() => save.mutate()}>
      <Field id="md-title" label="Title"><Input id="md-title" className="h-10" maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      <Field id="md-category" label="Category"><Input id="md-category" className="h-10" maxLength={60} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
      <Field id="md-confidentiality" label="Confidentiality">
        <Select value={form.confidentiality} onValueChange={(v) => setForm({ ...form, confidentiality: v as ErpDocument["confidentiality"] })}>
          <SelectTrigger id="md-confidentiality" className="h-10 w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(CONFIDENTIALITY).map(([k, label]) => <SelectItem key={k} value={k}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field id="md-description" label="Description"><Textarea id="md-description" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
    </ActionDialog>
  );
}

function Governance({ doc, onSaved, onFail }: { doc: ErpDocument; onSaved: Saved; onFail: () => void }) {
  const { withStepUp } = useStepUp();
  const [reason, setReason] = useState("");
  const [retention, setRetention] = useState(doc.retention_until ?? "");
  const hold = useMutation({
    mutationFn: (on: boolean) => withStepUp(() => unwrap(api.POST("/api/v1/documents/documents/{id}/legal-hold/", {
      params: { path: { id: doc.id } }, body: { legal_hold: on, reason, version: doc.version },
    }))),
    onSuccess: (d) => { onSaved(d, d.legal_hold ? "Legal hold placed" : "Legal hold released"); setReason(""); },
    onError: onFail,
  });
  const keep = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.POST("/api/v1/documents/documents/{id}/retention/", {
      params: { path: { id: doc.id } }, body: { retention_until: retention || null, version: doc.version },
    }))),
    onSuccess: (d) => onSaved(d, d.retention_until ? `Kept until ${date(d.retention_until)}` : "Retention date cleared"),
    onError: onFail,
  });
  return (
    <Section title="Retention and legal hold" description="A document can be deleted only after its retention date and while no legal hold applies.">
      <div className="grid gap-5 px-5 py-4">
        <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); keep.mutate(); }}>
          <div className="flex flex-wrap items-end gap-2">
            <Field id="ret-date" label="Keep until"><Input id="ret-date" type="date" className="h-10" value={retention} onChange={(e) => setRetention(e.target.value)} /></Field>
            <Button type="submit" variant="outline" className="h-10" disabled={keep.isPending || retention === (doc.retention_until ?? "")}>Save retention</Button>
          </div>
          <FormError message={problemMessage(keep.error)} />
        </form>
        <form className="grid gap-2 border-t pt-4" onSubmit={(e) => { e.preventDefault(); hold.mutate(!doc.legal_hold); }}>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="hold-switch" className="flex items-center gap-2"><Scale className="size-4" aria-hidden /> Legal hold {doc.legal_hold ? "is on" : "is off"}</Label>
            <Switch id="hold-switch" checked={doc.legal_hold} disabled={hold.isPending || (!doc.legal_hold && !reason.trim())} onCheckedChange={(v) => hold.mutate(v)} />
          </div>
          {doc.legal_hold && doc.legal_hold_reason && <p className="text-sm text-muted-foreground">Reason: {doc.legal_hold_reason}</p>}
          <Field id="hold-reason" label={doc.legal_hold ? "Reason for releasing" : "Reason for the hold"} hint={doc.legal_hold ? undefined : "Required to place a hold."}>
            <Input id="hold-reason" className="h-10" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <FormError message={problemMessage(hold.error)} />
        </form>
      </div>
    </Section>
  );
}

function Access({ doc }: { doc: ErpDocument }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const person = usePersonLabel();
  const [open, setOpen] = useState(false);
  const [grantee, setGrantee] = useState<Person | null>(null);
  const [role, setRole] = useState("");
  const [permission, setPermission] = useState<"read" | "write">("read");
  const canRoles = can("authorization.role.read");
  const key = ["documents", "document", doc.id, "acl"];
  const acl = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/api/v1/documents/documents/{id}/acl/", { params: { path: { id: doc.id } } })) });
  const roles = useQuery({
    queryKey: ["authorization", "roles", "all"],
    queryFn: () => unwrap(api.GET("/api/v1/authorization/roles/", { params: { query: { page_size: 200 } } })),
    enabled: canRoles,
  });
  const roleName = (id: string | null | undefined) => roles.data?.results.find((r) => r.id === id)?.name ?? "A role";
  const grant = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/documents/documents/{id}/acl/", {
      params: { path: { id: doc.id } }, body: grantee ? { user: grantee.id, permission } : { role, permission },
    })),
    onSuccess: () => {
      rememberPerson(grantee);
      queryClient.invalidateQueries({ queryKey: key });
      toast("Access granted");
      setOpen(false);
      setGrantee(null);
      setRole("");
    },
  });
  const revoke = useMutation({
    mutationFn: (aclId: string) => unwrap(api.DELETE("/api/v1/documents/documents/{id}/acl/{acl_id}/", { params: { path: { id: doc.id, acl_id: aclId } } })),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: key }); toast("Access revoked"); },
    onError: (e) => toast.error(problemMessage(e)),
  });
  if (acl.error) return <Section title="Access"><ErrorState error={acl.error} /></Section>;
  return (
    <Section title="Access" description={doc.confidentiality === "confidential" ? "Confidential: only the people and roles below can open it." : "Explicit grants in addition to the confidentiality level."}
      actions={
        <ActionDialog open={open} onOpenChange={setOpen} trigger={<Button variant="outline" size="sm"><UserPlus aria-hidden /> Grant</Button>}
          title="Grant access" submitLabel="Grant access" pending={grant.isPending} error={grant.error} disabled={!grantee && !role} onSubmit={() => grant.mutate()}>
          <Field id="acl-person" label="Person"><PersonField id="acl-person" value={grantee} onChange={(p) => { setGrantee(p); if (p) setRole(""); }} /></Field>
          {canRoles && (
            <Field id="acl-role" label="Or everyone holding a role">
              <Select value={role} onValueChange={(v) => { setRole(v); setGrantee(null); }}>
                <SelectTrigger id="acl-role" className="h-10 w-full"><SelectValue placeholder="Choose a role" /></SelectTrigger>
                <SelectContent>{(roles.data?.results ?? []).filter((r) => !r.is_system_template).map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          <Field id="acl-permission" label="Permission">
            <Select value={permission} onValueChange={(v) => setPermission(v as "read" | "write")}>
              <SelectTrigger id="acl-permission" className="h-10 w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="read">Read and download</SelectItem><SelectItem value="write">Read, download and change</SelectItem></SelectContent>
            </Select>
          </Field>
        </ActionDialog>
      }>
      {acl.data && acl.data.length === 0 ? <p className="px-5 py-4 text-sm text-muted-foreground">No explicit grants.</p> : (
        <ul className="divide-y" aria-label="Access entries">
          {(acl.data ?? []).map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 px-5 py-2.5">
              <Shield className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1 text-sm">
                <p className="truncate font-medium">{entry.user ? person(entry.user, "A colleague") : roleName(entry.role)}</p>
                <p className="text-xs text-muted-foreground">{entry.permission === "write" ? "Read and change" : "Read"} · granted {dateTime(entry.granted_at)}</p>
              </div>
              <Button variant="ghost" size="icon" aria-label="Revoke access" onClick={() => revoke.mutate(entry.id)} disabled={revoke.isPending}><X aria-hidden /></Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function DocumentDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useSession();
  const { withStepUp } = useStepUp();
  const person = usePersonLabel();
  const queryClient = useQueryClient();
  const key = ["documents", "document", id];
  const query = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/api/v1/documents/documents/{id}/", { params: { path: { id } } })) });
  const versions = useQuery({
    queryKey: ["documents", "document", id, "versions"],
    queryFn: () => unwrap(api.GET("/api/v1/documents/documents/{id}/versions/", { params: { path: { id } } })),
  });
  const onSaved: Saved = (doc, message) => {
    queryClient.setQueryData(key, doc);
    queryClient.invalidateQueries({ queryKey: ["documents", "library"] });
    queryClient.invalidateQueries({ queryKey: ["documents", "document", id, "versions"] });
    queryClient.invalidateQueries({ queryKey: ["collaboration", "activity"] });
    toast(message);
  };
  const onFail = () => queryClient.invalidateQueries({ queryKey: key });
  const download = useMutation({
    mutationFn: (versionNo?: number) => withStepUp(() => downloadDocument(id, versionNo)),
    onSuccess: (link) => toast(`Downloading ${link.filename} (v${link.version_no})`),
  });
  const remove = useMutation({
    mutationFn: () => withStepUp(() => unwrap(api.DELETE("/api/v1/documents/documents/{id}/", { params: { path: { id } } }))),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["documents", "library"] }); toast("Document deleted"); router.push("/documents"); },
  });

  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const doc = query.data!;
  const current = doc.current_version;
  const deletable = !doc.legal_hold && (!doc.retention_until || doc.retention_until < new Date().toISOString().slice(0, 10));

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Documents", href: "/documents" }, { label: doc.title }]}
        title={doc.title}
        meta={<>
          <StateBadge kind="confidentiality" value={doc.confidentiality} />
          {current && <span className="num text-muted-foreground">v{current.version_no} · {current.filename} · {fileSize(current.size)}</span>}
          {doc.legal_hold && <span className="inline-flex items-center gap-1 font-medium text-status-pending"><Scale className="size-4" aria-hidden /> Legal hold</span>}
        </>}
        actions={<>
          {can("documents.document.download") && current && (
            <Button size="lg" onClick={() => download.mutate(undefined)} disabled={download.isPending}><Download aria-hidden /> Download</Button>
          )}
          {can("documents.document.update") && <NewVersion doc={doc} onSaved={onSaved} onFail={onFail} />}
          {can("documents.document.update") && <EditMetadata doc={doc} onSaved={onSaved} onFail={onFail} />}
        </>}
      />
      {(download.error || remove.error) && <div className="mb-4"><FormError message={problemMessage(download.error ?? remove.error)} /></div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <Section title="Versions" description="Every upload is kept; the newest is current.">
            {versions.error ? <ErrorState error={versions.error} /> : (
              <ul className="divide-y" aria-label="Versions">
                {(versions.data ?? []).map((v) => (
                  <li key={v.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="num grid size-9 shrink-0 place-items-center rounded-md border text-sm font-semibold">v{v.version_no}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{v.filename}</p>
                      <p className="truncate text-xs text-muted-foreground">{fileSize(v.size)} · {dateTime(v.uploaded_at)} by {person(v.uploaded_by)}</p>
                      <p className="num truncate text-xs text-muted-foreground" title={v.sha256}>SHA-256 {v.sha256.slice(0, 16)}…</p>
                    </div>
                    {can("documents.document.download") && (
                      <Button variant="outline" size="icon-lg" aria-label={`Download version ${v.version_no}`} onClick={() => download.mutate(v.version_no)} disabled={download.isPending}><Download aria-hidden /></Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Details">
            <Facts items={[
              ["Category", doc.category || "—"],
              ["Description", doc.description || "—"],
              ["Created", `${dateTime(doc.created_at)} by ${person(doc.created_by)}`],
              ["Keep until", doc.retention_until ? date(doc.retention_until) : "No retention date"],
              doc.resource_type && ["Attached to", <span key="r" className="num break-all">{doc.resource_type} · {doc.resource_id}</span>],
            ]} />
          </Section>
          {can("documents.document.share") && <Access doc={doc} />}
        </div>
        <div className="grid min-w-0 content-start gap-6">
          {can("documents.document.manage") && <Governance doc={doc} onSaved={onSaved} onFail={onFail} />}
          {can("documents.document.delete") && (
            <Section title="Delete">
              <div className="grid gap-2 px-5 py-4">
                <p className="text-sm text-muted-foreground">{deletable ? "Removes the document and all its versions." : doc.legal_hold ? "Can't be deleted while a legal hold applies." : `Can't be deleted before ${date(doc.retention_until)}.`}</p>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" className="justify-self-start border-status-rejected/40 text-status-rejected hover:bg-status-rejected/10" disabled={!deletable || remove.isPending}><Trash2 aria-hidden /> Delete document</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this document?</AlertDialogTitle>
                      <AlertDialogDescription>&ldquo;{doc.title}&rdquo; and all its versions are removed. The deletion is audited.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </Section>
          )}
          <RecordPanel resourceType="documents.document" resourceId={doc.id} files={false} />
        </div>
      </div>
    </>
  );
}
