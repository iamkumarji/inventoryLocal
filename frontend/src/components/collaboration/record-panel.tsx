"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileUp, History, MessageSquare, Paperclip, Send } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Section } from "@/components/erp/page-header";
import { FormError } from "@/components/erp/field";
import { ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, idempotencyKey, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { problemMessage, rememberPerson, type ErpDocument } from "@/lib/api/production";
import { ago, dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

import { CommentBody, MentionInput } from "./mention-input";

/** Starts a browser download of a document version through a short-lived, audited link. */
export async function downloadDocument(id: string, versionNo?: number) {
  const link = await unwrap(api.POST("/api/v1/documents/documents/{id}/download/", {
    params: { path: { id } },
    body: versionNo ? { version_no: versionNo } : {},
  }));
  const a = document.createElement("a");
  a.href = link.url;
  a.download = link.filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  return link;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ACTIVITY_LABEL: Record<string, string> = {
  "collaboration.comment.created": "commented",
  "collaboration.comment.removed": "removed a comment",
};

function activityText(action: string): string {
  if (ACTIVITY_LABEL[action]) return ACTIVITY_LABEL[action];
  const verb = action.split(".").pop() ?? action;
  return verb.replace(/_/g, " ");
}

function Comments({ resourceType, resourceId }: { resourceType: string; resourceId: string }) {
  const { can, me } = useSession();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const key = ["collaboration", "comments", resourceType, resourceId];
  const comments = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(api.GET("/api/v1/collaboration/comments/", {
        params: { query: { resource_type: resourceType, resource_id: resourceId, page_size: 200 } },
      })),
  });
  const add = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/collaboration/comments/", { body: { resource_type: resourceType, resource_id: resourceId, body } })),
    onSuccess: (comment) => {
      setBody("");
      rememberPerson({ id: comment.author, full_name: comment.author_name });
      queryClient.invalidateQueries({ queryKey: ["collaboration", "comments", resourceType, resourceId] });
      queryClient.invalidateQueries({ queryKey: ["collaboration", "activity", resourceType, resourceId] });
      toast(comment.mentions.length ? `Comment posted; ${comment.mentions.length} mentioned ${comment.mentions.length === 1 ? "person" : "people"} notified` : "Comment posted");
    },
  });
  const remove = useMutation({
    mutationFn: (c: components["schemas"]["Comment"]) =>
      unwrap(api.POST("/api/v1/collaboration/comments/{id}/remove/", { params: { path: { id: c.id } }, body: { version: c.version } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
    onError: (error) => toast.error(problemMessage(error)),
  });
  const rows = comments.data?.results ?? [];

  return (
    <div className="grid gap-4">
      {comments.error ? <ErrorState error={comments.error} onRetry={comments.refetch} /> : comments.isLoading ? <RowsSkeleton rows={3} /> : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet. Mention a colleague with @ to bring them in.</p>
      ) : (
        <ol className="grid gap-3" aria-label="Comments">
          {rows.map((c) => (
            <li key={c.id} className="rounded-md border bg-background/60 px-3 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-sm font-medium">{c.author_name}</p>
                <time className="text-xs text-muted-foreground" dateTime={c.created_at} title={dateTime(c.created_at)}>{ago(c.created_at)}{c.edited_at && " · edited"}</time>
              </div>
              {c.is_removed ? <p className="text-sm text-muted-foreground italic">Comment removed.</p> : <CommentBody body={c.body} />}
              {c.author === me.user.id && !c.is_removed && (
                <Button variant="ghost" size="xs" className="mt-1 -ml-2 text-muted-foreground" onClick={() => remove.mutate(c)} disabled={remove.isPending}>Remove</Button>
              )}
            </li>
          ))}
        </ol>
      )}
      {can("collaboration.comment.create") && (
        <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(); }}>
          <Label htmlFor={`comment-${resourceId}`}>Add a comment</Label>
          <MentionInput id={`comment-${resourceId}`} value={body} onChange={setBody} placeholder="Type @ and a name to mention someone" />
          <FormError message={problemMessage(add.error)} />
          <Button type="submit" className="h-10 justify-self-start" disabled={add.isPending || !body.trim()}><Send aria-hidden /> Post comment</Button>
        </form>
      )}
    </div>
  );
}

function Activity({ resourceType, resourceId }: { resourceType: string; resourceId: string }) {
  const activity = useQuery({
    queryKey: ["collaboration", "activity", resourceType, resourceId],
    queryFn: () => unwrap(api.GET("/api/v1/collaboration/activity/", { params: { query: { resource_type: resourceType, resource_id: resourceId, limit: 100 } } })),
  });
  if (activity.error) return <ErrorState error={activity.error} onRetry={activity.refetch} />;
  if (activity.isLoading) return <RowsSkeleton rows={4} />;
  if (!activity.data?.length) return <p className="text-sm text-muted-foreground">Nothing has happened on this record yet.</p>;
  return (
    <ol className="relative grid gap-4 border-l pl-4" aria-label="Activity">
      {activity.data.map((e) => (
        <li key={`${e.kind}-${e.id}`} className="relative">
          <span aria-hidden className={`absolute top-1.5 -left-[1.3rem] size-2 rounded-[1px] ${e.kind === "comment" ? "bg-status-info" : "bg-status-neutral"}`} />
          <p className="text-sm"><span className="font-medium">{e.actor_label || "System"}</span> {activityText(e.action)}</p>
          {e.summary && <p className="line-clamp-2 text-sm text-muted-foreground">{e.summary}</p>}
          <time className="text-xs text-muted-foreground" dateTime={e.occurred_at}>{dateTime(e.occurred_at)}</time>
        </li>
      ))}
    </ol>
  );
}

function Attachments({ resourceType, resourceId }: { resourceType: string; resourceId: string }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const key = ["documents", "record", resourceType, resourceId];
  const docs = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET("/api/v1/documents/documents/", { params: { query: { resource_type: resourceType, resource_id: resourceId } } })),
  });
  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append("file", file!);
      form.append("title", file!.name.replace(/\.[^.]+$/, ""));
      form.append("resource_type", resourceType);
      form.append("resource_id", resourceId);
      return unwrap(api.POST("/api/v1/documents/documents/", {
        body: form as unknown as components["schemas"]["DocumentCreateRequest"],
        headers: { "Idempotency-Key": idempotencyKey() },
      }));
    },
    onSuccess: () => {
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: key });
      toast("File attached");
    },
  });
  const download = useMutation({ mutationFn: (doc: ErpDocument) => downloadDocument(doc.id), onError: (e) => toast.error(problemMessage(e)) });
  const rows = docs.data?.results ?? [];
  return (
    <div className="grid gap-4">
      {docs.error ? <ErrorState error={docs.error} onRetry={docs.refetch} /> : docs.isLoading ? <RowsSkeleton rows={2} /> : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No files attached.</p>
      ) : (
        <ul className="grid gap-2" aria-label="Attachments">
          {rows.map((d) => (
            <li key={d.id} className="flex items-center gap-3 rounded-md border bg-background/60 px-3 py-2">
              <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{d.title}</p>
                <p className="truncate text-xs text-muted-foreground">{d.current_version?.filename} · v{d.current_version?.version_no} · {d.current_version && fileSize(d.current_version.size)}</p>
              </div>
              {can("documents.document.download") && (
                <Button variant="outline" size="icon" aria-label={`Download ${d.title}`} onClick={() => download.mutate(d)} disabled={download.isPending}><Download aria-hidden /></Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {can("documents.document.create") && (
        <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (file) upload.mutate(); }}>
          <Label htmlFor={`attach-${resourceId}`}>Attach a file</Label>
          <Input ref={fileRef} id={`attach-${resourceId}`} type="file" className="h-10 py-1.5"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.docx,.csv,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <FormError message={problemMessage(upload.error)} />
          <Button type="submit" variant="outline" className="h-10 justify-self-start" disabled={!file || upload.isPending}><FileUp aria-hidden /> Upload</Button>
        </form>
      )}
    </div>
  );
}

/**
 * Side panel for any business record: comments with @mentions, the record's activity timeline and
 * attached files. Each tab appears only when the module is on and the caller may use it.
 */
export function RecordPanel({ resourceType, resourceId, className, files = true }: {
  resourceType: string;
  resourceId: string;
  className?: string;
  /** Show the attachments tab (off for records that are themselves documents). */
  files?: boolean;
}) {
  const { can, flag } = useSession();
  const showComments = flag("module.collaboration") && can("collaboration.comment.read");
  const showFiles = files && flag("module.documents") && can("documents.document.read");
  const [tab, setTab] = useState(showComments ? "comments" : "files");
  if (!showComments && !showFiles) return null;
  return (
    <Section title={showFiles ? "Discussion and files" : "Discussion"} className={className}>
      <Tabs value={tab} onValueChange={setTab} className="px-5 py-4">
        <TabsList className="mb-3 w-full">
          {showComments && <TabsTrigger value="comments" className="flex-1"><MessageSquare aria-hidden /> Comments</TabsTrigger>}
          {showComments && <TabsTrigger value="activity" className="flex-1"><History aria-hidden /> Activity</TabsTrigger>}
          {showFiles && <TabsTrigger value="files" className="flex-1"><Paperclip aria-hidden /> Files</TabsTrigger>}
        </TabsList>
        {showComments && <TabsContent value="comments"><Comments resourceType={resourceType} resourceId={resourceId} /></TabsContent>}
        {showComments && <TabsContent value="activity"><Activity resourceType={resourceType} resourceId={resourceId} /></TabsContent>}
        {showFiles && <TabsContent value="files"><Attachments resourceType={resourceType} resourceId={resourceId} /></TabsContent>}
      </Tabs>
    </Section>
  );
}

