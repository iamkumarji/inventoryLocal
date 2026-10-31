"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Field, FormError } from "@/components/erp/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";

type LoginStatus = "authenticated" | "mfa_required" | "mfa_enrollment_required" | "password_change_required";

function safeNext(value: string | null): string {
  // Only same-site relative paths; never redirect to another origin.
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function messageFor(error: unknown): string | undefined {
  if (!error) return undefined;
  if (isApiError(error, "account_locked")) return "Too many failed attempts. The account is locked for a few minutes.";
  if (isApiError(error, "throttled")) return "Too many attempts from this device. Wait a minute and try again.";
  if (isApiError(error) && error.status === 401) return error.problem.detail === "Invalid credentials."
    ? "Email or password is incorrect."
    : error.problem.detail;
  return "The server couldn't be reached. Check your connection and try again.";
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  const route = (status: LoginStatus) => {
    queryClient.removeQueries({ queryKey: ["auth", "me"] });
    if (status === "mfa_enrollment_required") router.replace("/setup/mfa");
    else if (status === "password_change_required") router.replace("/setup/password");
    else router.replace(next);
  };

  const signIn = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/api/v1/auth/login/", { body: { email, password, client_type: "web" } })),
    onSuccess: (data) => {
      if (data.status === "mfa_required" && data.challenge_token) setChallenge(data.challenge_token);
      else route(data.status as LoginStatus);
    },
  });

  const verify = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/api/v1/auth/login/mfa/", { body: { challenge_token: challenge!, code } })),
    onSuccess: (data) => route(data.status as LoginStatus),
    onError: () => setCode(""),
  });

  if (challenge) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          verify.mutate();
        }}
        className="grid gap-6"
      >
        <div>
          <h1 className="type-signage text-[1.75rem]">Two-step verification</h1>
          <p className="mt-2 text-muted-foreground">
            {useRecovery
              ? "Enter one of the recovery codes you saved when you set up your authenticator. Each code works once."
              : "Open your authenticator app and enter the 6-digit code for OtabuPro ERP."}
          </p>
        </div>
        <FormError message={verify.error ? (isApiError(verify.error) ? verify.error.problem.detail : messageFor(verify.error)) : undefined} />
        {useRecovery ? (
          <Field id="recovery" label="Recovery code">
            <Input id="recovery" autoFocus autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)}
              placeholder="ABCDE-FGHJK" className="num tracking-widest uppercase" />
          </Field>
        ) : (
          <InputOTP maxLength={6} value={code} onChange={setCode} autoFocus aria-label="Verification code"
            onComplete={() => verify.mutate()}>
            <InputOTPGroup>
              {Array.from({ length: 6 }, (_, i) => <InputOTPSlot key={i} index={i} className="size-11 text-lg" />)}
            </InputOTPGroup>
          </InputOTP>
        )}
        <Button type="submit" size="lg" disabled={verify.isPending || code.trim().length < 6}>
          {verify.isPending ? "Verifying…" : "Verify"}
        </Button>
        <div className="flex justify-between text-sm">
          <button type="button" className="text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => { setUseRecovery(!useRecovery); setCode(""); }}>
            {useRecovery ? "Use authenticator code" : "Use a recovery code"}
          </button>
          <button type="button" className="text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => { setChallenge(null); setCode(""); verify.reset(); }}>
            Start over
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        signIn.mutate();
      }}
      className="grid gap-5"
    >
      <div className="mb-2">
        <h1 className="type-signage text-[1.75rem]">Sign in</h1>
        <p className="mt-2 text-muted-foreground">Use your work email. Your administrator can reset access if you&apos;re locked out.</p>
      </div>
      <FormError message={messageFor(signIn.error)} />
      <Field id="email" label="Work email">
        <Input id="email" type="email" autoComplete="username" required autoFocus value={email}
          onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field id="password" label="Password">
        <Input id="password" type="password" autoComplete="current-password" required value={password}
          onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Button type="submit" size="lg" className="mt-1" disabled={signIn.isPending}>
        {signIn.isPending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
