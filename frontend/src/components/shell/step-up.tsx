"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";

type StepUp = { withStepUp: <T>(action: () => Promise<T>) => Promise<T> };
const StepUpContext = createContext<StepUp | null>(null);

export function useStepUp(): StepUp {
  const value = useContext(StepUpContext);
  if (!value) throw new Error("useStepUp must be used inside <StepUpProvider>");
  return value;
}

/**
 * Sensitive actions (permission changes, approvals above policy thresholds, user resets)
 * need a recent MFA check. When the API answers `mfa_required`, ask for a code and retry once.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const queryClient = useQueryClient();

  const verify = useMutation({
    mutationFn: (value: string) => unwrap(api.POST("/api/v1/auth/step-up/", { body: { code: value } })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      finish(true);
    },
  });

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
    setCode("");
    verify.reset();
  };

  const withStepUp = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (!isApiError(error, "mfa_required")) throw error;
      const ok = await new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setOpen(true);
      });
      if (!ok) throw error;
      return action();
    }
  }, []);

  return (
    <StepUpContext.Provider value={{ withStepUp }}>
      {children}
      <Dialog open={open} onOpenChange={(next) => !next && finish(false)}>
        <DialogContent className="sm:max-w-sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              verify.mutate(code);
            }}
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldCheck className="size-5 text-status-info" aria-hidden />
                Confirm it&apos;s you
              </DialogTitle>
              <DialogDescription>
                This action needs a fresh verification. Enter the 6-digit code from your authenticator app, or a
                recovery code.
              </DialogDescription>
            </DialogHeader>
            <div className="my-5 grid gap-2">
              <Label htmlFor="step-up-code">Verification code</Label>
              <Input
                id="step-up-code"
                autoFocus
                autoComplete="one-time-code"
                inputMode="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                aria-invalid={verify.isError}
                className="num text-lg tracking-[0.3em]"
              />
              {verify.isError && <p className="text-sm text-destructive">That code didn&apos;t work. Try the current one.</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => finish(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={code.trim().length < 6 || verify.isPending}>
                Verify and continue
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </StepUpContext.Provider>
  );
}
