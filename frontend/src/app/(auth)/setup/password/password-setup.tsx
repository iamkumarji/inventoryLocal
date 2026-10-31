"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { PasswordChangeForm } from "@/components/erp/password-change-form";
import { api } from "@/lib/api/client";

export function PasswordSetup() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="type-signage text-[1.75rem]">Choose a new password</h1>
        <p className="mt-2 text-muted-foreground">
          You signed in with a temporary password. Replace it with one only you know.
        </p>
      </div>
      <PasswordChangeForm
        currentLabel="Temporary password"
        submitLabel="Save password and continue"
        onDone={() => {
          queryClient.removeQueries({ queryKey: ["auth", "me"] });
          router.replace("/");
        }}
      />
      <button
        type="button"
        onClick={async () => {
          await api.POST("/api/v1/auth/logout/");
          queryClient.clear();
          router.replace("/login");
        }}
        className="justify-self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        Sign out
      </button>
    </div>
  );
}
