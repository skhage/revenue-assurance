// Thin client for the billing dispute API (server/routes/disputes.ts).

import type {
  DisputeRecord,
  DisputeSummary,
  DisputeCheckTypeBreakdown,
  DisputeCustomerSummary,
  DisputeCheckType,
} from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface DisputeDetailFilters {
  check_type?: DisputeCheckType;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  limit?: number;
}

export interface DisputeCustomerFilters {
  top_n?: number;
  check_type?: DisputeCheckType;
}

export const disputeApi = {
  /** Headline KPIs for the disputes tab. */
  summary: (signal?: AbortSignal) =>
    fetch('/api/disputes/summary', { signal }).then((r) =>
      json<DisputeSummary>(r)
    ),

  /** Check-type breakdown (7 rows). */
  breakdown: (signal?: AbortSignal) =>
    fetch('/api/disputes/breakdown', { signal }).then((r) =>
      json<DisputeCheckTypeBreakdown[]>(r)
    ),

  /** Exception detail, filterable by check type and severity. */
  detail: (filters: DisputeDetailFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.check_type) params.set('check_type', filters.check_type);
    if (filters.severity) params.set('severity', filters.severity);
    if (filters.limit) params.set('limit', String(filters.limit));
    return fetch(`/api/disputes/detail?${params}`, { signal }).then((r) =>
      json<DisputeRecord[]>(r)
    );
  },

  /** Customer drill-down — top customers by dispute exposure. */
  customers: (filters: DisputeCustomerFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.top_n) params.set('top_n', String(filters.top_n));
    if (filters.check_type) params.set('check_type', filters.check_type);
    return fetch(`/api/disputes/customers?${params}`, { signal }).then((r) =>
      json<DisputeCustomerSummary[]>(r)
    );
  },
};
