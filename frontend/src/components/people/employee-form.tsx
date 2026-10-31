"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { Field } from "@/components/erp/field";
import { PersonPicker, type Person } from "@/components/erp/person-picker";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { useScopeTree } from "@/lib/api/hooks";
import { useDepartments } from "@/lib/api/people";
import type { ScopeTree } from "@/lib/scopes";
import { useSession } from "@/lib/session";

export type EmployeeDraft = {
  code: string;
  full_name: string;
  department: string;
  branch: string;
  user: Person | null;
  designation: string;
  grade: string;
  date_of_joining: string;
  work_email: string;
  phone: string;
  bank_ifsc: string;
  /** Write-only sensitive inputs: sent once, never read back. Empty = leave unchanged. */
  pan: string;
  bank_account_number: string;
  aadhaar_last4: string;
};

export const EMPTY_EMPLOYEE: EmployeeDraft = {
  code: "", full_name: "", department: "", branch: "", user: null, designation: "", grade: "",
  date_of_joining: "", work_email: "", phone: "", bank_ifsc: "", pan: "", bank_account_number: "", aadhaar_last4: "",
};

/** Label for the linked sign-in account (the API only returns its id). */
function LinkedUser({ id }: { id: string }) {
  const { can } = useSession();
  const user = useQuery({
    queryKey: ["identity", "user", id],
    queryFn: () => unwrap(api.GET("/api/v1/identity/users/{id}/", { params: { path: { id } } })),
    enabled: can("identity.user.read"),
  });
  return <>{user.data ? `${user.data.full_name} (${user.data.email})` : "A sign-in account is linked"}</>;
}

/** Fields shared by "Add employee" and the employee record. */
export function EmployeeFields({ value, onChange, errors, mode, linkedUserId, masked, disabled }: {
  value: EmployeeDraft;
  onChange: (next: EmployeeDraft) => void;
  errors: Record<string, string>;
  mode: "create" | "edit";
  linkedUserId?: string | null;
  masked?: { pan: string; bank: string; aadhaar: string };
  disabled?: boolean;
}) {
  const { activeCompany } = useSession();
  const departments = useDepartments();
  const tree = useScopeTree();
  const company = (tree.data as ScopeTree | undefined)?.companies.find((c) => c.id === activeCompany?.id);
  const deptOptions = (departments.data?.results ?? []).filter((d) => !activeCompany || d.company === activeCompany.id);
  const set = (key: keyof EmployeeDraft) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [key]: e.target.value });
  const sensitive = (key: "pan" | "bank_account_number" | "aadhaar_last4", label: string, current: string | undefined, hint: ReactNode, maxLength: number) => (
    <Field id={key} label={label} error={errors[key]} hint={hint}>
      <Input id={key} type="password" autoComplete="new-password" spellCheck={false} maxLength={maxLength} value={value[key]}
        onChange={set(key)} disabled={disabled} placeholder={current ? `On file: ${current}` : "Not on file"} />
    </Field>
  );

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {mode === "create" && (
          <Field id="code" label="Employee code" error={errors.code}>
            <Input id="code" value={value.code} onChange={set("code")} required maxLength={30} disabled={disabled} />
          </Field>
        )}
        <Field id="full_name" label="Full name" error={errors.full_name}>
          <Input id="full_name" value={value.full_name} onChange={set("full_name")} required maxLength={200} disabled={disabled} />
        </Field>
        <Field id="department" label="Department" error={errors.department}>
          <Select value={value.department} onValueChange={(v) => onChange({ ...value, department: v })} disabled={disabled}>
            <SelectTrigger id="department" className="w-full"><SelectValue placeholder="Choose a department" /></SelectTrigger>
            <SelectContent>{deptOptions.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field id="branch" label="Branch" error={errors.branch} hint="Optional">
          <Select value={value.branch || "none"} onValueChange={(v) => onChange({ ...value, branch: v === "none" ? "" : v })} disabled={disabled}>
            <SelectTrigger id="branch" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No branch</SelectItem>
              {company?.branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field id="date_of_joining" label="Date of joining" error={errors.date_of_joining}>
          <Input id="date_of_joining" type="date" value={value.date_of_joining} onChange={set("date_of_joining")} required disabled={disabled} />
        </Field>
        <Field id="designation" label="Designation" error={errors.designation}>
          <Input id="designation" value={value.designation} onChange={set("designation")} maxLength={120} disabled={disabled} />
        </Field>
        <Field id="grade" label="Grade" error={errors.grade}>
          <Input id="grade" value={value.grade} onChange={set("grade")} maxLength={40} disabled={disabled} />
        </Field>
        <Field id="work_email" label="Work email" error={errors.work_email}>
          <Input id="work_email" type="email" value={value.work_email} onChange={set("work_email")} disabled={disabled} />
        </Field>
        <Field id="phone" label="Phone" error={errors.phone}>
          <Input id="phone" value={value.phone} onChange={set("phone")} maxLength={30} disabled={disabled} />
        </Field>
      </div>
      <Field id="user" label="Sign-in account" error={errors.user}
        hint={mode === "edit" && linkedUserId && !value.user ? <>Currently: <LinkedUser id={linkedUserId} />. Choose someone else to relink.</> : "Links self-service (leave, payslips, expenses) to this person."}>
        <PersonPicker id="user" value={value.user} onChange={(p) => onChange({ ...value, user: p })} placeholder={mode === "edit" && linkedUserId ? "Keep the current link" : "No account linked"} />
      </Field>
      <fieldset className="grid gap-4 rounded-md border px-4 pt-2 pb-4">
        <legend className="px-1 text-sm font-medium">Bank and identity</legend>
        <p className="text-xs text-muted-foreground">Stored encrypted. Only a masked hint is ever shown; type a new value to replace it.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="bank_ifsc" label="Bank IFSC" error={errors.bank_ifsc}>
            <Input id="bank_ifsc" value={value.bank_ifsc} onChange={set("bank_ifsc")} maxLength={11} className="uppercase" disabled={disabled} />
          </Field>
          {sensitive("bank_account_number", "Bank account number", masked?.bank, "6 to 20 digits", 20)}
          {sensitive("pan", "PAN", masked?.pan, "5 letters, 4 digits, 1 letter", 10)}
          {sensitive("aadhaar_last4", "Aadhaar, last 4 digits", masked?.aadhaar, "Never the full number", 4)}
        </div>
      </fieldset>
    </div>
  );
}

type WriteBody = components["schemas"]["EmployeeWriteRequest"];

/** Body for create/update: untouched sensitive fields are left out (an empty value would clear them). */
export function employeeBody(draft: EmployeeDraft): WriteBody {
  const body: WriteBody = {
    code: draft.code.trim(),
    full_name: draft.full_name.trim(),
    department: draft.department,
    branch: draft.branch || null,
    designation: draft.designation.trim(),
    grade: draft.grade.trim(),
    date_of_joining: draft.date_of_joining,
    work_email: draft.work_email.trim(),
    phone: draft.phone.trim(),
    bank_ifsc: draft.bank_ifsc.trim().toUpperCase(),
  };
  if (draft.user) body.user = draft.user.id;
  for (const key of ["pan", "bank_account_number", "aadhaar_last4"] as const) {
    if (draft[key].trim()) body[key] = draft[key].trim();
  }
  return body;
}
