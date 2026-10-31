"use client";

import { Check, X } from "lucide-react";
import { useState } from "react";

import { Field } from "@/components/erp/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/** Approve or reject with a comment (a reason is required to reject). */
export function DecideDialog({ approve, title, description, pending, onDecide }: {
  approve: boolean;
  title: string;
  description: string;
  pending: boolean;
  onDecide: (comment: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={approve ? "default" : "outline"} disabled={pending}>
          {approve ? <Check aria-hidden /> : <X aria-hidden />} {approve ? "Approve" : "Reject"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); onDecide(comment.trim()); setOpen(false); setComment(""); }}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Field id="decision-comment" label={approve ? "Comment (optional)" : "Reason"}>
            <Textarea id="decision-comment" value={comment} onChange={(e) => setComment(e.target.value)} rows={3} required={!approve} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant={approve ? "default" : "destructive"} disabled={!approve && !comment.trim()}>
              {approve ? "Approve" : "Reject"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
