// Thin client for the alerts API (server/routes/alerts.ts).

import type { EmergingRisk, LeakageAlert, CriticalSummary } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface EmergingLeakageFilters {
  customer_id?: number;
  min_composite_score?: number;
}

export interface LeakageAlertFilters {
  alert_type?: 'ANOMALY_SPIKE' | 'FORECAST_BREACH' | 'CONCENTRATION_RISK' | 'ALL';
  severity_floor?: 'CRITICAL' | 'ELEVATED' | 'WATCH';
}

export const alertsApi = {
  /** Emerging leakage — customer risk profiles with signal levels. */
  emerging: (filters: EmergingLeakageFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.customer_id) params.set('customer_id', String(filters.customer_id));
    if (filters.min_composite_score) params.set('min_composite_score', String(filters.min_composite_score));
    return fetch(`/api/alerts/emerging?${params}`, { signal }).then((r) =>
      json<EmergingRisk[]>(r)
    );
  },

  /** Leakage alerts — structured alert payloads by type and severity. */
  leakage: (filters: LeakageAlertFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.alert_type) params.set('alert_type', filters.alert_type);
    if (filters.severity_floor) params.set('severity_floor', filters.severity_floor);
    return fetch(`/api/alerts/leakage?${params}`, { signal }).then((r) =>
      json<LeakageAlert[]>(r)
    );
  },

  /** Critical alert count — for the header badge. */
  criticalSummary: (signal?: AbortSignal) =>
    fetch('/api/alerts/critical-summary', { signal }).then((r) => json<CriticalSummary>(r)),
};
