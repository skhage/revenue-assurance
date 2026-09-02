// Thin client for the Lakebase-backed case API (server/routes/cases.ts).

export const STATUSES = ['New', 'Investigating', 'Recovering', 'Recovered', 'WrittenOff'] as const;
export type Status = (typeof STATUSES)[number];

export interface CaseRow {
  exception_id: string;
  reference_id: string | null;
  account_name: string | null;
  check_type: string | null;
  severity: string | null;
  amount_at_risk: number | null;
  status: Status;
  assignee: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CaseNote {
  id: number;
  author: string | null;
  body: string;
  created_at: string;
}

export interface CasePayload {
  case: CaseRow | null;
  notes: CaseNote[];
  /** True when an idempotency-keyed note request was a no-op retry (a note with this key already existed). */
  deduped?: boolean;
}

/** Metadata sent when lazily creating a case from a queue row. */
export interface ExceptionMeta {
  reference_id?: string | null;
  account_name?: string | null;
  check_type?: string | null;
  severity?: string | null;
  amount_at_risk?: number | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const casesApi = {
  whoami: () => fetch('/api/whoami').then((r) => json<{ user: string }>(r)),
  stats: () => fetch('/api/cases/stats').then((r) => json<Record<Status, number>>(r)),
  list: (mine = false) => fetch(`/api/cases${mine ? '?mine=1' : ''}`).then((r) => json<CaseRow[]>(r)),
  get: (id: string) => fetch(`/api/cases/${id}`).then((r) => json<CasePayload>(r)),

  assign: (id: string, assignee: string, meta: ExceptionMeta) =>
    fetch(`/api/cases/${id}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignee, meta }),
    }).then((r) => json<CasePayload>(r)),

  changeStatus: (id: string, status: Status, note: string | undefined, meta: ExceptionMeta) =>
    fetch(`/api/cases/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, note, meta }),
    }).then((r) => json<CasePayload>(r)),

  /**
   * `idempotencyKey`, when supplied, makes this call durably safe to retry:
   * the server guarantees at most one note is ever inserted per
   * (exception_id, idempotencyKey) pair, even if an earlier attempt's
   * response was lost, the calling component remounted, or the page was
   * reloaded before the mutation that follows the note completed. Callers
   * that write an audit note before a case-lifecycle mutation should always
   * pass one — see agents/* panels for the per-approved-run convention
   * `agent:<slug>:<exception_id>:<run_id>`.
   */
  addNote: (id: string, body: string, meta: ExceptionMeta, idempotencyKey?: string) =>
    fetch(`/api/cases/${id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, meta, idempotencyKey }),
    }).then((r) => json<CasePayload>(r)),
};

// Allowed next states (mirror of the server guard) for building the UI dropdown.
export const NEXT_STATUS: Record<Status, Status[]> = {
  New: ['Investigating', 'WrittenOff'],
  Investigating: ['Recovering', 'WrittenOff'],
  Recovering: ['Recovered', 'WrittenOff'],
  Recovered: [],
  WrittenOff: [],
};
