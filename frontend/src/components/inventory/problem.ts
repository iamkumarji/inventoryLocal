import { isApiError } from "@/lib/api/errors";

const EXPLAINED_DENIALS = new Set(["self_approval", "maker_checker", "approval_limit", "sod"]);

/**
 * One readable sentence for an API failure, shown next to the action that caused it.
 * The API hides why a permission check failed (no reason leaks), so callers pass the
 * likely explanation for their action as `denied`.
 */
export function problemText(error: unknown, denied?: string): string | undefined {
  if (!error) return undefined;
  if (!isApiError(error)) return "Couldn't reach the server. Check your connection and try again.";
  switch (error.type) {
    case "version_conflict":
      return "Someone changed this while you were working on it. The latest version is now shown; check it and try again.";
    case "permission_denied":
      // Controls on the caller's own action (self-approval, maker-checker, approval limit, SoD) come with a
      // code and a readable reason; plain refusals don't say why, so the caller's likely explanation is shown.
      if (error.problem.code && EXPLAINED_DENIALS.has(error.problem.code)) return error.problem.detail;
      return denied ?? "You don't have permission to do this here.";
    case "invalid_state_transition":
      return `${error.problem.detail} Reload to see the current state.`;
    case "idempotency_in_progress":
      return "This action is still being processed. Wait a moment, then reload.";
    case "feature_disabled":
      return "This module is switched off. Ask an administrator to enable it.";
    case "validation_error": {
      // Field paths (`item_id`, `lines[2].quantity`) mean nothing to people; keep the line number only.
      const first = error.problem.errors?.[0];
      if (!first) return error.problem.detail;
      const line = first.field?.match(/^(?:lines)?\[(\d+)\]/);
      return line ? `Line ${Number(line[1]) + 1}: ${first.message}` : first.message;
    }
    default:
      return error.summary();
  }
}

/** The business-rule code (e.g. `insufficient_stock`) when the API sent one, for display next to the message. */
export function problemCode(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  const code = error.problem.code;
  return code && code !== error.type ? code : undefined;
}

/** Field errors keyed by path (e.g. `lines[0].quantity`). */
export function fieldErrors(error: unknown): Record<string, string> {
  return isApiError(error) ? error.fieldErrors() : {};
}

/** Field-level validation errors are shown on their inputs; anything else goes in the banner. */
export function bannerError(error: unknown): unknown {
  if (!error) return null;
  if (!isApiError(error, "validation_error")) return error;
  const fields = error.fieldErrors();
  return Object.keys(fields).length === 0 || fields._form ? error : null;
}
