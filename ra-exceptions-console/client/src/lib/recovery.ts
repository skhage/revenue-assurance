// Thin client for the recovery API (server/routes/recovery.ts).

import type { RecoveryOpportunity, RecoverySummary } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface RecoveryFilters {
  customer_id?: number;
  max_results?: number;
  min_recovery_estimate?: number;
}

export const recoveryApi = {
  /** Ranked recovery opportunities with action plans. */
  actionPlan: (filters: RecoveryFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.customer_id) params.set('customer_id', String(filters.customer_id));
    if (filters.max_results) params.set('max_results', String(filters.max_results));
    if (filters.min_recovery_estimate) params.set('min_recovery_estimate', String(filters.min_recovery_estimate));
    return fetch(`/api/recovery/action-plan?${params}`, { signal }).then((r) =>
      json<RecoveryOpportunity[]>(r)
    );
  },

  /** Recovery headline metrics for the dashboard. */
  summary: (signal?: AbortSignal) =>
    fetch('/api/recovery/summary', { signal }).then((r) => json<RecoverySummary>(r)),
};
