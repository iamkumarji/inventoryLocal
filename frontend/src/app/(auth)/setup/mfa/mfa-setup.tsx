"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download } from "lucide-react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { FormError } from "@/components/erp/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { api, unwrap } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { fetchMe, ME_KEY } from "@/lib/session";

export function MfaSetup() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ME_KEY, queryFn: fetchMe, retry: false });
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isApiError(me.error) && me.error.status === 401) router.replace("/login");
  }, [me.error, router]);

  const start = useMutation({ mutationFn: () => unwrap(api.POST("/api/v1/auth/mfa/totp/setup/")) });
  const confirm = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/auth/mfa/totp/confirm/", { body: { code } })),
    onSuccess: (data) => setCodes(data.recovery_codes),
    onError: () => setCode(""),
  });

  const finish = async () => {
    const fresh = await queryClient.fetchQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 0 });
    router.replace(fresh.session.restricted_reason === "password_change" ? "/setup/password" : "/");
  };

  const restricted = me.data?.session.restricted_reason === "mfa_enrollment";
  const skipUntil = me.data?.mfa.skip_until ?? null;
  const skip = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/auth/mfa/skip/")),
    onSuccess: async () => {
      toast("Two-step sign-in postponed. You'll be reminded each time you sign in.");
      await finish();
    },
  });

  const signOut = async () => {
    await api.POST("/api/v1/auth/logout/");
    queryClient.clear();
    router.replace("/login");
  };

  if (codes) {
    const text = codes.join("\n");
    return (
      <div className="grid gap-6">
        <div>
          <h1 className="type-signage text-[1.75rem]">Save your recovery codes</h1>
          <p className="mt-2 text-muted-foreground">
            If you lose your phone, each code signs you in once. They won&apos;t be shown again.
          </p>
        </div>
        <ol className="num grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border bg-card p-5 text-[0.95rem] tracking-wider">
          {codes.map((c) => <li key={c}>{c}</li>)}
        </ol>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigator.clipboard.writeText(text).then(() => toast("Codes copied"))}>
            <Copy aria-hidden /> Copy
          </Button>
          <Button variant="outline" asChild>
            <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`} download="otabupro-recovery-codes.txt">
              <Download aria-hidden /> Download
            </a>
          </Button>
        </div>
        <div className="flex items-center gap-2.5">
          <Checkbox id="saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
          <Label htmlFor="saved">I&apos;ve stored these codes somewhere safe</Label>
        </div>
        <Button size="lg" disabled={!saved} onClick={finish}>Continue</Button>
      </div>
    );
  }

  const alreadyEnrolled = isApiError(start.error) && start.error.problem.code === "mfa_already_enrolled";

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="type-signage text-[1.75rem]">Set up two-step verification</h1>
        <p className="mt-2 text-muted-foreground">
          {restricted ? "Your account needs" : "Add"} a code from an authenticator app (such as Google Authenticator,
          Microsoft Authenticator or 1Password) each time you sign in.
        </p>
      </div>

      {alreadyEnrolled && (
        <FormError message="Two-step verification is already set up for this account. Continue, or ask an administrator to reset it." />
      )}

      {!start.data ? (
        <div className="grid gap-3">
          <Button size="lg" onClick={() => start.mutate()} disabled={start.isPending || alreadyEnrolled}>
            {start.isPending ? "Preparing…" : "Set up authenticator"}
          </Button>
          {alreadyEnrolled && <Button variant="outline" onClick={finish}>Continue</Button>}
          {restricted && skipUntil && !alreadyEnrolled && (
            <div className="grid gap-1">
              <Button variant="outline" size="lg" onClick={() => skip.mutate()} disabled={skip.isPending}>
                {skip.isPending ? "Skipping…" : "Skip for now"}
              </Button>
              <p className="text-sm text-muted-foreground">
                You can postpone this until {new Date(skipUntil).toLocaleDateString()}. Until then a few sensitive actions
                (such as posting payments or viewing salaries) stay locked.
              </p>
            </div>
          )}
          {!restricted && (
            <Button variant="ghost" onClick={() => router.replace("/account/security")}>Not now</Button>
          )}
          <FormError message={skip.error ? (isApiError(skip.error) ? skip.error.summary() : "Couldn't reach the server.") : undefined} />
        </div>
      ) : (
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate();
          }}
        >
          <div className="flex gap-5 rounded-lg border bg-card p-5">
            <div className="shrink-0 rounded-md bg-white p-2">
              <QRCodeSVG value={start.data.otpauth_uri} size={132} marginSize={0} title="Authenticator QR code" />
            </div>
            <div className="min-w-0 text-sm">
              <p className="font-medium">Scan with your app</p>
              <p className="mt-1 text-muted-foreground">Can&apos;t scan? Enter this key manually:</p>
              <p className="num mt-2 break-all text-[0.8rem] tracking-wider select-all">
                {start.data.secret.match(/.{1,4}/g)?.join(" ")}
              </p>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Enter the 6-digit code your app shows</Label>
            <InputOTP maxLength={6} value={code} onChange={setCode} aria-label="Verification code">
              <InputOTPGroup>
                {Array.from({ length: 6 }, (_, i) => <InputOTPSlot key={i} index={i} className="size-11 text-lg" />)}
              </InputOTPGroup>
            </InputOTP>
          </div>
          <FormError message={confirm.error ? "That code didn't match. Check your phone's clock and try the current code." : undefined} />
          <Button type="submit" size="lg" disabled={code.length < 6 || confirm.isPending}>
            {confirm.isPending ? "Checking…" : "Turn on two-step verification"}
          </Button>
        </form>
      )}
      <button type="button" onClick={signOut} className="justify-self-start text-sm text-muted-foreground underline-offset-4 hover:underline">
        Sign out
      </button>
    </div>
  );
}
