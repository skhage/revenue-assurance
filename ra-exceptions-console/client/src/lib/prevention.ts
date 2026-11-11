// Thin client for the prevention intelligence API (server/routes/prevention.ts).

import type {
  PreventionIntelligenceRow,
  PreventionSummary,
  PreventionRuleRow,
  PreventionRoiRow,
} from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface IntelligenceFilters {
  min_written_off?: number;
  min_recurrence?: number;
  top_n?: number;
}

export interface RulesFilters {
  prevention_category?: string;
  top_n?: number;
}

export interface RoiFilters {
  budget?: number;
  horizon_months?: number;
  top_n?: number;
}

export const preventionApi = {
  /** Systemic root causes ranked by preventable leakage. */
  intelligence: (filters: IntelligenceFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.min_written_off !== undefined) params.set('min_written_off', String(filters.min_written_off));
    if (filters.min_recurrence !== undefined) params.set('min_recurrence', String(filters.min_recurrence));
    if (filters.top_n) params.set('top_n', String(filters.top_n));
    return fetch(`/api/prevention/intelligence?${params}`, { signal }).then((r) =>
      json<PreventionIntelligenceRow[]>(r)
    );
  },

  /** Actionable prevention rules with triggers and enforcement. */
  rules: (filters: RulesFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.prevention_category) params.set('prevention_category', filters.prevention_category);
    if (filters.top_n) params.set('top_n', String(filters.top_n));
    return fetch(`/api/prevention/rules?${params}`, { signal }).then((r) =>
      json<PreventionRuleRow[]>(r)
    );
  },

  /** ROI business case — initiatives ranked by payback period. */
  roi: (filters: RoiFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.budget !== undefined) params.set('budget', String(filters.budget));
    if (filters.horizon_months) params.set('horizon_months', String(filters.horizon_months));
    if (filters.top_n) params.set('top_n', String(filters.top_n));
    return fetch(`/api/prevention/roi?${params}`, { signal }).then((r) =>
      json<PreventionRoiRow[]>(r)
    );
  },

  /** Prevention headline KPIs. */
  summary: (signal?: AbortSignal) =>
    fetch('/api/prevention/summary', { signal }).then((r) => json<PreventionSummary>(r)),
};
