// Thin client for the compliance API (server/routes/compliance.ts).

import type { ComplianceContract, ComplianceStatusCount } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface ComplianceFilters {
  contract_number?: string;
  mismatch_only?: boolean;
}

export const complianceApi = {
  /** Full compliance profile per contract. */
  scan: (filters: ComplianceFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.contract_number) params.set('contract_number', filters.contract_number);
    if (filters.mismatch_only) params.set('mismatch_only', 'true');
    return fetch(`/api/compliance/scan?${params}`, { signal }).then((r) =>
      json<ComplianceContract[]>(r)
    );
  },

  /** Compliance status distribution for dashboard badge. */
  summary: (signal?: AbortSignal) =>
    fetch('/api/compliance/summary', { signal }).then((r) => json<ComplianceStatusCount[]>(r)),
};
