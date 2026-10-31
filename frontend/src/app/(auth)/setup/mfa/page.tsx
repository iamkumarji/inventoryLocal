import type { Metadata } from "next";

import { MfaSetup } from "./mfa-setup";

export const metadata: Metadata = { title: "Set up two-step verification" };

export default function Page() {
  return <MfaSetup />;
}
