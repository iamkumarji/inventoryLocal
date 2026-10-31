/** Problem details returned by the API (docs/API_SPECIFICATION.md §3). */
export type FieldError = { field: string | null; code: string; message: string };

export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code?: string;
  errors?: FieldError[];
  meta?: Record<string, unknown>;
  request_id?: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(status: number, problem: Partial<Problem> | undefined) {
    const p: Problem = {
      type: problem?.type ?? "error",
      title: problem?.title ?? "Request failed",
      status,
      detail: problem?.detail ?? "The request could not be completed.",
      ...problem,
    };
    super(p.detail);
    this.status = status;
    this.problem = p;
  }

  get type() {
    return this.problem.type;
  }

  /** Errors keyed by field path, for mapping onto form inputs. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.problem.errors ?? []) out[e.field ?? "_form"] ??= e.message;
    return out;
  }

  /** One line suitable for a toast. */
  summary(): string {
    if (this.problem.errors?.length) {
      const first = this.problem.errors[0];
      return first.field ? `${first.field}: ${first.message}` : first.message;
    }
    return this.problem.detail;
  }
}

export function isApiError(error: unknown, type?: string): error is ApiError {
  return error instanceof ApiError && (type === undefined || error.type === type);
}
