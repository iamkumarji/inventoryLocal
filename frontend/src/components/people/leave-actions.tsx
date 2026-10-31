"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/erp/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { errorText, today, trimDecimal, type LeaveRequest } from "@/lib/api/people";
import { date } from "@/lib/format";

/** Approved leave can be cancelled only before it starts; drafts and rejected requests any time. */
export function canCancelLeave(r: LeaveRequest): boolean {
  return r.status === "draft" || r.status === "rejected" || (r.status === "approved" && r.from_date > today());
}

export function CancelLeave({ request, onDone, size = "sm" }: { request: LeaveRequest; onDone?: () => void; size?: "sm" | "default" }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const cancel = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/hr/leave-requests/{id}/cancel/", {
      params: { path: { id: request.id } },
      body: { reason, version: request.version },
    })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      setOpen(false);
      toast(request.status === "approved" ? "Leave cancelled; the days are back in the balance" : "Leave request cancelled");
      onDone?.();
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["people"] });
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline" size={size}><Ban aria-hidden /> Cancel leave</Button></DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); cancel.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Cancel this leave?</DialogTitle>
            <DialogDescription>
              {date(request.from_date)} to {date(request.to_date)}, {trimDecimal(request.days)} day(s).
              {request.status === "approved" && " The days return to the balance."}
            </DialogDescription>
          </DialogHeader>
          <FormError message={cancel.error ? errorText(cancel.error) : undefined} />
          <Field id="cancel-reason" label="Reason" hint="Optional">
            <Input id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Keep it</Button>
            <Button type="submit" variant="destructive" disabled={cancel.isPending}>Cancel leave</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SubmitLeave({ request }: { request: LeaveRequest }) {
  const queryClient = useQueryClient();
  const submit = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/hr/leave-requests/{id}/submit/", {
      params: { path: { id: request.id } },
      body: { version: request.version },
    })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      toast("Leave request submitted for approval");
    },
    onError: (error) => {
      toast.error(errorText(error));
      if (isApiError(error, "version_conflict")) queryClient.invalidateQueries({ queryKey: ["people"] });
    },
  });
  return <Button size="sm" variant="outline" disabled={submit.isPending} onClick={() => submit.mutate()}><Send aria-hidden /> Submit</Button>;
}
