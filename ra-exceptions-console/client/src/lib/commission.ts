// Thin client for the commission leakage API (server/routes/commission.ts).

import type {
  CommissionRecord,
  CommissionSummary,
  CommissionSubTypeBreakdown,
  CommissionAgentSummary,
  CommissionSubCheckType,
} from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface CommissionDetailFilters {
  sub_check_type?: CommissionSubCheckType;
  severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  limit?: number;
}

export interface CommissionAgentFilters {
  top_n?: number;
  sub_check_type?: CommissionSubCheckType;
}

export const commissionApi = {
  /** Headline KPIs for the commission tab. */
  summary: (signal?: AbortSignal) =>
    fetch('/api/commission/summary', { signal }).then((r) =>
      json<CommissionSummary>(r)
    ),

  /** Sub-check type breakdown (6 rows). */
  breakdown: (signal?: AbortSignal) =>
    fetch('/api/commission/breakdown', { signal }).then((r) =>
      json<CommissionSubTypeBreakdown[]>(r)
    ),

  /** Exception detail, filterable by sub-check type and severity. */
  detail: (filters: CommissionDetailFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.sub_check_type) params.set('sub_check_type', filters.sub_check_type);
    if (filters.severity) params.set('severity', filters.severity);
    if (filters.limit) params.set('limit', String(filters.limit));
    return fetch(`/api/commission/detail?${params}`, { signal }).then((r) =>
      json<CommissionRecord[]>(r)
    );
  },

  /** Agent fraud drill-down — top agents by exposure. */
  agents: (filters: CommissionAgentFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.top_n) params.set('top_n', String(filters.top_n));
    if (filters.sub_check_type) params.set('sub_check_type', filters.sub_check_type);
    return fetch(`/api/commission/agents?${params}`, { signal }).then((r) =>
      json<CommissionAgentSummary[]>(r)
    );
  },
};
