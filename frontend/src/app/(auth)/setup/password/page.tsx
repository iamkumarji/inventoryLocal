import type { Metadata } from "next";

import { PasswordSetup } from "./password-setup";

export const metadata: Metadata = { title: "Choose a new password" };

export default function Page() {
  return <PasswordSetup />;
}
