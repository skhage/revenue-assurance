// Thin client for the triage API (server/routes/triage.ts).

import type {
  TriageClassification,
  TriagePriority,
  PlaybookStep,
  P1Summary,
  PriorityDistribution,
  AdaptiveTriageResult,
} from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface BatchTriageFilters {
  priority?: TriagePriority;
  check_type?: string;
  row_limit?: number;
  row_offset?: number;
}

export const triageApi = {
  /** Batch-triaged exception list with priority/check_type filters. */
  batch: (filters: BatchTriageFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.check_type) params.set('check_type', filters.check_type);
    if (filters.row_limit) params.set('row_limit', String(filters.row_limit));
    if (filters.row_offset) params.set('row_offset', String(filters.row_offset));
    return fetch(`/api/triage/batch?${params}`, { signal }).then((r) =>
      json<Record<string, unknown>[]>(r)
    );
  },

  /** Classify a single exception — returns priority, urgency, rationale. */
  classify: (
    params: {
      check_type: string;
      amount_at_risk: number;
      review_priority?: string;
      customer_risk_tier?: string;
      anomaly_rank?: number;
    },
    signal?: AbortSignal
  ) => {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    );
    return fetch(`/api/triage/classify?${qs}`, { signal }).then((r) =>
      json<TriageClassification | null>(r)
    );
  },

  /** Investigation playbook — step-by-step actions for an exception. */
  playbook: (
    params: {
      check_type: string;
      customer_id: number;
      amount_at_risk: number;
      reference_id?: string;
    },
    signal?: AbortSignal
  ) => {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    );
    return fetch(`/api/triage/playbook?${qs}`, { signal }).then((r) =>
      json<PlaybookStep[]>(r)
    );
  },

  /** P1 summary — count and total amount for the dashboard badge. */
  p1Summary: (signal?: AbortSignal) =>
    fetch('/api/triage/p1-summary', { signal }).then((r) => json<P1Summary>(r)),

  /** Priority distribution — for the overview breakdown. */
  distribution: (signal?: AbortSignal) =>
    fetch('/api/triage/distribution', { signal }).then((r) =>
      json<PriorityDistribution[]>(r)
    ),

  /** Adaptive triage — learning-informed priority and routing recommendation. */
  adaptiveTriage: (
    params: {
      check_type: string;
      amount_at_risk: number;
      customer_id: number;
      severity?: string;
    },
    signal?: AbortSignal
  ) => {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    );
    return fetch(`/api/triage/adaptive?${qs}`, { signal }).then((r) =>
      json<AdaptiveTriageResult | null>(r)
    );
  },
};
