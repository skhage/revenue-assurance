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
  version: number;
  identity_status: string;
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
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      currentVersion?: number;
    };
    throw new CasesApiError(body.error || res.statusText, body.code, body.currentVersion);
  }
  return res.json() as Promise<T>;
}

export class CasesApiError extends Error {
  readonly code?: string;
  readonly currentVersion?: number;

  constructor(message: string, code?: string, currentVersion?: number) {
    super(message);
    this.name = 'CasesApiError';
    this.code = code;
    this.currentVersion = currentVersion;
  }
}

export const casesApi = {
  whoami: () => fetch('/api/whoami').then((r) => json<{ user: string }>(r)),
  stats: () => fetch('/api/cases/stats').then((r) => json<Record<Status, number>>(r)),
  list: (mine = false) => fetch(`/api/cases${mine ? '?mine=1' : ''}`).then((r) => json<CaseRow[]>(r)),
  get: (id: string) => fetch(`/api/cases/${id}`).then((r) => json<CasePayload>(r)),

  assign: (id: string, assignee: string, expectedVersion: number, meta: ExceptionMeta) =>
    fetch(`/api/cases/${id}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignee, expectedVersion, meta }),
    }).then((r) => json<CasePayload>(r)),

  changeStatus: (id: string, status: Status, note: string | undefined, expectedVersion: number, meta: ExceptionMeta) =>
    fetch(`/api/cases/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, note, expectedVersion, meta }),
    }).then((r) => json<CasePayload>(r)),

  addNote: (id: string, body: string, expectedVersion: number, meta: ExceptionMeta) =>
    fetch(`/api/cases/${id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, expectedVersion, meta }),
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
