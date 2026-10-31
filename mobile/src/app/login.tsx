import { Redirect } from "expo-router";
import { useState } from "react";

import { Button, Heading, Input, Notice, Screen } from "@/components/ui";
import { useSession } from "@/lib/session";

export default function Login() {
  const { state, login, completeMfa } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status === "signed_in") return <Redirect href="/" />;
  const notice = state.status === "signed_out" ? state.notice : undefined;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const outcome = challenge ? await completeMfa(challenge, code.trim()) : await login(email.trim(), password);
    setBusy(false);
    if (outcome.kind === "mfa") setChallenge(outcome.challenge);
    else if (outcome.kind === "error") setError(outcome.message);
  };

  return (
    <Screen>
      <Heading sub="Warehouse, delivery and field work">OtabuPro ERP</Heading>
      {notice ? <Notice tone="warn">{notice}</Notice> : null}
      {challenge ? (
        <Input
          testID="mfa-code"
          label="6-digit code from your authenticator app"
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          maxLength={10}
          onSubmitEditing={submit}
        />
      ) : (
        <>
          <Input testID="email" label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" />
          <Input testID="password" label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" onSubmitEditing={submit} />
        </>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button testID="sign-in" title={challenge ? "Verify" : "Sign in"} onPress={submit} busy={busy} disabled={challenge ? code.trim().length < 6 : !email || !password} />
      {challenge ? <Button title="Start over" kind="secondary" onPress={() => (setChallenge(null), setCode(""))} /> : null}
    </Screen>
  );
}
