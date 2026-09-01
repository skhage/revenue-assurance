// Client for the check-type-aware evidence endpoint (server/routes/evidence.ts).

export type EvidenceFormat = 'usd' | 'pct' | 'int' | 'text' | 'bool';

export interface EvidenceRow {
  label: string;
  left?: unknown;
  right?: unknown;
  value?: unknown;
  mismatch?: boolean;
  format?: EvidenceFormat;
}

export interface EvidencePayload {
  kind: string;
  comparison?: { leftLabel: string; rightLabel: string };
  rows: EvidenceRow[];
  document?: { label: string; fileName: string; url: string | null };
  note?: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const evidenceApi = {
  get: (
    params: { check_type: string; reference_id: string; customer_id: number | null },
    signal?: AbortSignal
  ) => {
    const q = new URLSearchParams({
      check_type: params.check_type,
      reference_id: params.reference_id ?? '',
      customer_id: params.customer_id == null ? '' : String(params.customer_id),
    });
    return fetch(`/api/analytics/evidence?${q}`, { signal }).then((res) => json<EvidencePayload>(res));
  },
};
