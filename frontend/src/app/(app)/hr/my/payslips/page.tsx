import { redirect } from "next/navigation";

/** Payslip notifications link here; self-service lives under /me. */
export default function Page() {
  redirect("/me/payslips");
}
