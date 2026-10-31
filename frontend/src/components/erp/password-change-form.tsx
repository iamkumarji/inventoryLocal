"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Field, FormError } from "@/components/erp/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";

export function PasswordChangeForm({ onDone, currentLabel = "Current password", submitLabel = "Change password" }: {
  onDone: () => void;
  currentLabel?: string;
  submitLabel?: string;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && next !== confirm;

  const change = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/api/v1/auth/password/change/", { body: { current_password: current, new_password: next } })),
    onSuccess: onDone,
  });
  const errors = isApiError(change.error) ? change.error.fieldErrors() : {};

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!mismatch) change.mutate();
      }}
    >
      {change.error && !isApiError(change.error, "validation_error") && (
        <FormError message={isApiError(change.error) ? change.error.summary() : "Couldn't reach the server."} />
      )}
      <Field id="current-password" label={currentLabel} error={errors.current_password}>
        <Input id="current-password" type="password" autoComplete="current-password" required value={current}
          onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field id="new-password" label="New password" error={errors.new_password}
        hint="At least 12 characters. A short sentence is easier to remember than a jumble of symbols.">
        <Input id="new-password" type="password" autoComplete="new-password" required minLength={12} value={next}
          onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field id="confirm-password" label="Repeat new password" error={mismatch ? "The passwords don't match." : undefined}>
        <Input id="confirm-password" type="password" autoComplete="new-password" required value={confirm}
          onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <Button type="submit" size="lg" className="mt-1" disabled={change.isPending || mismatch || !next}>
        {change.isPending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
