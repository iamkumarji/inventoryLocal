"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Paperclip, Upload } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api/client";
import { errorText } from "@/lib/api/people";
import { dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

const CLAIM = "expenses.expense_claim";

/** Receipts need the documents module and document permissions (employees may only have a reference). */
export function useReceiptAccess() {
  const { can, flag } = useSession();
  const on = flag("module.documents");
  return { canRead: on && can("documents.document.read"), canUpload: on && can("documents.document.create") };
}

/** Upload a receipt file attached to the claim; resolves to the new document id. */
export function useUploadReceipt(claimId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.set("file", file);
      form.set("title", `Receipt: ${file.name}`.slice(0, 200));
      form.set("category", "receipt");
      form.set("confidentiality", "restricted");
      form.set("resource_type", CLAIM);
      form.set("resource_id", claimId);
      const doc = await unwrap(api.POST("/api/v1/documents/documents/", {
        body: form as never,
        bodySerializer: (body: unknown) => body as FormData,
      }));
      return doc.id;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["people", "receipts", claimId] }),
    onError: (error) => toast.error(errorText(error)),
  });
}

export function UploadReceiptButton({ claimId, onUploaded, label = "Attach file" }: { claimId: string; onUploaded: (documentId: string) => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useUploadReceipt(claimId);
  return (
    <>
      <input ref={input} type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" tabIndex={-1} aria-hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onUploaded(await upload.mutateAsync(file));
        }} />
      <Button type="button" variant="outline" size="sm" disabled={upload.isPending} onClick={() => input.current?.click()}>
        <Upload aria-hidden /> {upload.isPending ? "Uploading…" : label}
      </Button>
    </>
  );
}

/** Files attached to a claim, with short-lived download links. */
export function ClaimAttachments({ claimId }: { claimId: string }) {
  const { canRead } = useReceiptAccess();
  const docs = useQuery({
    queryKey: ["people", "receipts", claimId],
    queryFn: () => unwrap(api.GET("/api/v1/documents/documents/", { params: { query: { resource_type: CLAIM, resource_id: claimId } } })),
    enabled: canRead,
  });
  const download = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/api/v1/documents/documents/{id}/download/", { params: { path: { id } }, body: {} })),
    onSuccess: (d) => window.open(d.url, "_blank", "noopener"),
    onError: (error) => toast.error(errorText(error)),
  });
  if (!canRead || !docs.data || docs.data.results.length === 0) return null;
  return (
    <ul className="divide-y border-t">
      {docs.data.results.map((d) => (
        <li key={d.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
          <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1"><span className="block truncate">{d.title}</span><span className="block text-xs text-muted-foreground">{dateTime(d.created_at)}</span></span>
          <Button variant="ghost" size="sm" disabled={download.isPending} onClick={() => download.mutate(d.id)}><Download aria-hidden /> Open</Button>
        </li>
      ))}
    </ul>
  );
}
