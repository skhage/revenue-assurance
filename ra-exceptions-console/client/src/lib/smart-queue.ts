// Thin client for the smart queue API (server/routes/smart-queue.ts).

import type {
  SmartQueueItem,
  SmartQueueSummary,
  PredictedRecoveryItem,
  TriageEffectivenessRow,
} from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface WorkQueueFilters {
  analyst_capacity?: number;
  focus_check_type?: string;
  min_predicted_value?: number;
}

export interface RecoveryOppsFilters {
  check_type?: string;
  min_amount?: number;
  priority_filter?: string;
  top_n?: number;
}

export interface TriageEffFilters {
  check_type?: string;
  min_cases?: number;
}

export const smartQueueApi = {
  /** Optimized daily analyst queue ranked by ROI-per-hour. */
  workQueue: (filters: WorkQueueFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.analyst_capacity) params.set('analyst_capacity', String(filters.analyst_capacity));
    if (filters.focus_check_type) params.set('focus_check_type', filters.focus_check_type);
    if (filters.min_predicted_value !== undefined) params.set('min_predicted_value', String(filters.min_predicted_value));
    return fetch(`/api/smart-queue/work-queue?${params}`, { signal }).then((r) =>
      json<SmartQueueItem[]>(r)
    );
  },

  /** Ranked unworked exceptions by predicted $ recovery. */
  recoveryOpportunities: (filters: RecoveryOppsFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.check_type) params.set('check_type', filters.check_type);
    if (filters.min_amount !== undefined) params.set('min_amount', String(filters.min_amount));
    if (filters.priority_filter) params.set('priority_filter', filters.priority_filter);
    if (filters.top_n) params.set('top_n', String(filters.top_n));
    return fetch(`/api/smart-queue/recovery-opportunities?${params}`, { signal }).then((r) =>
      json<PredictedRecoveryItem[]>(r)
    );
  },

  /** Per-check_type triage accuracy analysis. */
  triageEffectiveness: (filters: TriageEffFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.check_type) params.set('check_type', filters.check_type);
    if (filters.min_cases) params.set('min_cases', String(filters.min_cases));
    return fetch(`/api/smart-queue/triage-effectiveness?${params}`, { signal }).then((r) =>
      json<TriageEffectivenessRow[]>(r)
    );
  },

  /** Smart queue headline KPIs. */
  summary: (signal?: AbortSignal) =>
    fetch('/api/smart-queue/summary', { signal }).then((r) => json<SmartQueueSummary>(r)),
};
